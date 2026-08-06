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
  decorations: DecorationSet
  private fragments: readonly TreeFragment[] = []

  constructor(view: EditorView) {
    this.decorations = this.computeDecorations(view)
  }

  /**
   * Reparse (incrementally, reusing prior fragments) and rebuild the decoration set. Returns an
   * empty set — and does no parsing — when the view is not a blueprint file or has no Jinja
   * syntax, so the plugin is free on ordinary Markdown editors. Callers must first advance
   * `this.fragments` through any document changes (see `update`) so reuse stays aligned.
   */
  private computeDecorations(view: EditorView): DecorationSet {
    if (!viewShowsBlueprint(view)) {
      this.fragments = []
      return Decoration.none
    }

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

  update(update: ViewUpdate) {
    // Rebuild ONLY when the document or the rendered viewport actually changed. A pure cursor /
    // selection movement must not reparse or rebuild — that was the source of the editor jank.
    if (!update.docChanged && !update.viewportChanged) {
      return
    }

    // Keep the reusable parse fragments aligned with the new document before any reuse. Without
    // this, incremental parsing would splice old subtrees in at stale offsets and the token
    // decorations would drift after an edit.
    if (update.docChanged) {
      const changedRanges: { fromA: number; toA: number; fromB: number; toB: number }[] = []
      update.changes.iterChangedRanges((fromA, toA, fromB, toB) =>
        changedRanges.push({ fromA, toA, fromB, toB }),
      )
      this.fragments = TreeFragment.applyChanges(this.fragments, changedRanges)
    }

    if (update.view.composing && update.docChanged) {
      // During IME composition, defer the reparse: just shift the existing decorations. The
      // fragments were advanced above, so the reparse after composition ends stays correct.
      this.decorations = this.decorations.map(update.changes)
      return
    }

    this.decorations = this.computeDecorations(update.view)
  }
}

const blueprintHighlightPlugin = ViewPlugin.fromClass(BlueprintHighlighter, {
  decorations: (plugin: BlueprintHighlighter) => plugin.decorations,
})

/**
 * Markdown view used for `.blueprint` files when the experimental syntax-highlighting setting is
 * on. Highlighting itself is provided by `blueprintHighlightPlugin`, registered once as an editor
 * extension in the plugin's `onload` — this view no longer touches editor modes or CodeMirror
 * internals.
 */
class BlueprintExtendedView extends MarkdownView {
  constructor(leaf: WorkspaceLeaf) {
    super(leaf)
  }

  getViewType(): string {
    return VIEW_TYPE_BLUEPRINT
  }

  getDisplayText(): string {
    return this.file?.basename || 'Blueprint'
  }
}

export { BlueprintExtendedView, VIEW_TYPE_BLUEPRINT, blueprintHighlightPlugin }
