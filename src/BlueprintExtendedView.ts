import { jinja } from '@codemirror/lang-jinja'
import { RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  DecorationSet,
  EditorView,
  PluginValue,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view'
import { Tree, TreeFragment } from '@lezer/common'
import { MarkdownView, WorkspaceLeaf, editorInfoField } from 'obsidian'
import { BLUEPRINT_FILE_EXTENSION } from './constants'

const VIEW_TYPE_BLUEPRINT = 'blueprint'

// We only need the Jinja/Nunjucks parser to build our token decorations; we deliberately do
// NOT install the `jinja()` LanguageSupport as an editor language. Blueprint files are edited
// as Markdown, and our highlighting is layered on top as decorations — installing the Jinja
// language would replace Obsidian's Markdown editing for the whole document.
const jinjaParser = jinja().language.parser

const TAG_STYLES: Record<string, string> = Object.fromEntries(
  Object.entries({
    keyword:
      'TagName raw endraw filter endfilter as trans pluralize endtrans with endwith autoescape endautoescape if elif else endif for endfor call endcall block endblock set endset macro endmacro import from include',
    variable:
      'VariableName Definition PropertyName required scoped recursive without context ignore missing loop super',
    function: 'FilterName',
    operator: 'ArithOp AssignOp CompareOp not and or in is',
    punctuation: 'FilterOp ConcatOp {% %} {# #} {{ }} { } ( ) . : , .',
    string: 'StringLiteral',
    number: 'NumberLiteral',
    boolean: 'BooleanLiteral',
  }).flatMap(([style, tags]) => tags.split(' ').map((tag) => [tag, style])),
)

/**
 * True when the editor is showing a `.blueprint` file. The highlighter is registered as a
 * global editor extension (it is attached to every Markdown editor), so it must scope itself
 * to blueprint files and stay completely inert everywhere else — no parse, no decorations.
 */
function viewShowsBlueprint(view: EditorView): boolean {
  const info = view.state.field(editorInfoField, false)
  return info?.file?.extension === BLUEPRINT_FILE_EXTENSION
}

// Cheap secondary guard: nothing to highlight if the document has no Jinja delimiters at all.
function hasJinjaDelimiters(doc: string): boolean {
  return doc.includes('{%') || doc.includes('{{') || doc.includes('{#')
}

class BlueprintHighlighter implements PluginValue {
  decorations: DecorationSet = Decoration.none
  private fragments: readonly TreeFragment[] = []
  // Whether the current blueprint document has had its decorations built at least once. Gated on
  // this flag (never on decoration emptiness — a blueprint with no Jinja has empty decorations
  // legitimately) so we can guarantee exactly one initial build without looping.
  private hasBuilt = false
  // Set when the document changed during IME composition, so we reparse once composition ends.
  private dirtyWhileComposing = false

  constructor(
    view: EditorView,
    private readonly isEnabled: () => boolean,
  ) {
    // Build eagerly if the view context is already known at construction. If `editorInfoField`
    // is not yet populated (so `viewShowsBlueprint` is false here), the first `update` that sees
    // a blueprint file performs the one-time build instead — highlighting never waits for an edit.
    if (this.isEnabled() && viewShowsBlueprint(view)) {
      this.decorations = this.buildFromScratch(view)
      this.hasBuilt = true
    }
  }

  /** Reset fragments and parse the whole document fresh (used for the initial build). */
  private buildFromScratch(view: EditorView): DecorationSet {
    this.fragments = []
    return this.parseAndBuild(view)
  }

  /**
   * Reparse (incrementally, reusing `this.fragments`) and rebuild the decoration set. Callers
   * must have already confirmed the view is an enabled blueprint file and advanced the fragments
   * through any document changes. Returns an empty set — with no parse — when the document has no
   * Jinja delimiters at all.
   */
  private parseAndBuild(view: EditorView): DecorationSet {
    const doc = view.state.doc.toString()
    if (!hasJinjaDelimiters(doc)) {
      this.fragments = []
      return Decoration.none
    }

    const tree = jinjaParser.parse(doc, this.fragments)
    this.fragments = TreeFragment.addTree(tree, this.fragments)
    return this.buildDecorations(tree)
  }

  private buildDecorations(tree: Tree): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>()

    const cursor = tree.cursor()
    while (cursor.next()) {
      const style = TAG_STYLES[cursor.name]
      if (style) {
        builder.add(cursor.from, cursor.to, Decoration.mark({ class: `token ${style}` }))
      }
    }

    return builder.finish()
  }

  /** Advance the reusable parse fragments through this update's document changes. */
  private advanceFragments(update: ViewUpdate) {
    const changedRanges: { fromA: number; toA: number; fromB: number; toB: number }[] = []
    update.changes.iterChangedRanges((fromA, toA, fromB, toB) =>
      changedRanges.push({ fromA, toA, fromB, toB }),
    )
    this.fragments = TreeFragment.applyChanges(this.fragments, changedRanges)
  }

  update(update: ViewUpdate) {
    // Truly inert on non-blueprint editors and when the feature is off. This runs on every
    // keystroke of every Markdown note, so it must bail BEFORE any allocation or fragment work.
    if (!this.isEnabled() || !viewShowsBlueprint(update.view)) {
      if (this.hasBuilt || this.dirtyWhileComposing) {
        this.decorations = Decoration.none
        this.fragments = []
        this.hasBuilt = false
        // Clear any pending composition rebuild too, so a composition interrupted by the view
        // going inert doesn't force a stray reparse if the view becomes active again.
        this.dirtyWhileComposing = false
      }
      return
    }

    // During active IME composition, NEVER reparse or rebuild — that can cancel/garble the
    // composition. Only shift existing decorations to track inserted text, and defer any needed
    // rebuild to the first update after composition ends. This holds regardless of
    // docChanged/viewportChanged.
    if (update.view.composing) {
      if (update.docChanged) {
        this.advanceFragments(update)
        this.decorations = this.decorations.map(update.changes)
      }
      // Defer the rebuild whenever one is pending: a document edit to reflect, OR the one-time
      // initial build that never ran because editorInfoField was unready at construction and the
      // very first update is a composition start. We must NOT build mid-composition, so in that
      // narrow case pre-existing Jinja stays unhighlighted until composition commits.
      if (update.docChanged || !this.hasBuilt) {
        this.dirtyWhileComposing = true
      }
      return
    }

    // Rebuild on real document changes only — including text committed by a just-ended
    // composition. `viewportChanged` is deliberately NOT a rebuild trigger: buildDecorations
    // covers the whole document, so scrolling needs no reparse (scroll-time reparsing was the jank).
    if (update.docChanged || this.dirtyWhileComposing) {
      if (update.docChanged) {
        this.advanceFragments(update)
      }
      this.dirtyWhileComposing = false
      this.decorations = this.parseAndBuild(update.view)
      this.hasBuilt = true
      return
    }

    // Guaranteed one-time initial build: the setting was just toggled on, or editorInfoField
    // wasn't populated at construction. Flag-gated so it happens exactly once.
    if (!this.hasBuilt) {
      this.decorations = this.buildFromScratch(update.view)
      this.hasBuilt = true
    }
  }
}

/**
 * The syntax-highlighting editor extension. Registered globally (on every Markdown editor) but
 * inert unless the editor shows a `.blueprint` file AND `isEnabled()` returns true — the setting
 * is read live, so toggling it takes effect without stacking or reloading. `isEnabled` closes
 * over the plugin's settings so the runtime value is always current.
 */
function blueprintHighlightExtension(isEnabled: () => boolean) {
  return ViewPlugin.define((view) => new BlueprintHighlighter(view, isEnabled), {
    decorations: (plugin: BlueprintHighlighter) => plugin.decorations,
  })
}

/**
 * Markdown view used for `.blueprint` files when the experimental syntax-highlighting setting is
 * on. Highlighting itself is provided by the globally-registered `blueprintHighlightExtension`,
 * so this view no longer touches editor modes or CodeMirror internals.
 */
class BlueprintExtendedView extends MarkdownView {
  constructor(leaf: WorkspaceLeaf) {
    super(leaf)
  }

  getViewType(): string {
    return VIEW_TYPE_BLUEPRINT
  }
}

export { BlueprintExtendedView, VIEW_TYPE_BLUEPRINT, blueprintHighlightExtension }
