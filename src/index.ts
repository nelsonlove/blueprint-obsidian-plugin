import * as nunjucks from 'nunjucks'
import { Menu, Plugin, TFile, TFolder } from 'obsidian'
import {
  BlueprintExtendedView,
  VIEW_TYPE_BLUEPRINT,
  blueprintHighlightExtension,
} from './BlueprintExtendedView'
import { BlueprintSettingTab } from './BlueprintSettingTab'
import { BlueprintView } from './BlueprintView'
import {
  applyBlueprintToFile,
  createBlueprint,
  createBlueprintInFolder,
  createNoteFromBlueprint,
  createNoteFromBlueprintInFolder,
  executeFileBlueprint,
  executeFolderBlueprint,
  executeFolderBlueprints,
  updateBlueprintNotes,
} from './commands'
import {
  DEFAULT_BLUEPRINT_SUFFIX,
  extensionToRegister,
  LEGACY_BLUEPRINT_SUFFIX,
  normalizeSuffix,
} from './constants'
import { EnsureError, fileHasBlueprint, fileIsBlueprint } from './utils'

interface BlueprintPluginSettings {
  experimentalHasBlueprintSyntaxHighlight: boolean
  /** Filename suffix marking a blueprint, e.g. `.blueprint.md` or `.blueprint`. */
  blueprintSuffix: string
}

const DEFAULT_SETTINGS: BlueprintPluginSettings = {
  experimentalHasBlueprintSyntaxHighlight: false,
  blueprintSuffix: DEFAULT_BLUEPRINT_SUFFIX,
}

export { EnsureError } from './utils'

export interface BlueprintPluginApi {
  /**
   * Apply the blueprint linked in the note's `blueprint` frontmatter property,
   * without requiring the note to be open or active. Resolves once the note
   * has been updated.
   *
   * The note's metadata must already be indexed: if the note was just created
   * or modified, wait for the metadata cache to reflect the change (e.g. via
   * `metadataCache.on('changed', ...)`) before calling, otherwise the call
   * rejects — or renders from stale metadata.
   *
   * Rejects with `EnsureError` when a precondition fails (the file is itself a
   * blueprint, no blueprint link, blueprint not resolvable, no cached metadata,
   * note changed while rendering, plugin not loaded), and with the underlying
   * template error when rendering fails.
   */
  applyToFile: (file: TFile) => Promise<void>

  /**
   * The error class used for precondition failures, exposed here so
   * consumers can branch with `instanceof` (class and export names are
   * not reachable across plugin bundles).
   */
  EnsureError: typeof EnsureError
}

export default class BlueprintPlugin extends Plugin {
  declare settings: BlueprintPluginSettings

  private isReady = false

  readonly api: BlueprintPluginApi = {
    applyToFile: async (file) => {
      if (!this.isReady) {
        throw new EnsureError('Blueprint plugin is not loaded')
      }
      // Every internal path refuses this via fileHasBlueprint; the API must too.
      // A caller iterating markdown files and applying to each would otherwise
      // render a blueprint into itself — reachable now that blueprints are
      // ordinary notes with a metadata cache entry.
      if (fileIsBlueprint(file, this.suffix)) {
        throw new EnsureError(`${file.basename} is a blueprint, not a note with a blueprint`)
      }
      return applyBlueprintToFile(this.app, file, this.suffix)
    },
    EnsureError,
  }

  /** The configured suffix, always usable — a broken setting falls back. */
  get suffix(): string {
    return normalizeSuffix(this.settings?.blueprintSuffix)
  }

  async onload() {
    await this.loadSettings()

    this.addSettingTab(new BlueprintSettingTab(this.app, this))
    nunjucks.configure({ autoescape: false, trimBlocks: true })

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        menu.addItem((item) => {
          item.setTitle('Blueprint').setIcon('layout')

          // @ts-ignore
          const subMenu: Menu = item.setSubmenu()

          if (file instanceof TFolder) {
            subMenu.addItem((item) => {
              item
                .setTitle('New blueprint')
                .onClick(async () => createBlueprintInFolder(this.app, file.path, this.suffix))
            })
            subMenu.addItem((item) => {
              item
                .setTitle('New note from blueprint')
                .onClick(async () => createNoteFromBlueprintInFolder(this.app, file.path, this.suffix))
            })
            subMenu.addItem((item) => {
              item
                .setTitle('Update all notes with blueprints')
                .onClick(async () => executeFolderBlueprints(this.app, file, this.suffix))
            })
            subMenu.addItem((item) => {
              item
                .setTitle('Update all notes using specific blueprint')
                .onClick(async () => executeFolderBlueprint(this.app, file, this.suffix))
            })
          }
          if (file instanceof TFile && fileHasBlueprint(this.app, file, this.suffix)) {
            subMenu.addItem((item) => {
              item
                .setTitle('Apply blueprint')
                .onClick(async () => executeFileBlueprint(this.app, file, this.suffix, true))
            })
          }
          if (file instanceof TFile && fileIsBlueprint(file, this.suffix)) {
            subMenu.addItem((item) => {
              item
                .setTitle('Update notes using this blueprint')
                .onClick(async () => updateBlueprintNotes(this.app, file, this.suffix))
            })
          }
        })
      }),
    )

    this.addCommand({
      id: 'apply-blueprint',
      name: 'Apply blueprint',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile()

        if (file && fileHasBlueprint(this.app, file, this.suffix)) {
          if (!checking) {
            void executeFileBlueprint(this.app, file, this.suffix, true)
          }
          return true
        }

        return false
      },
    })

    this.addCommand({
      id: 'apply-blueprints-in-all-notes-in-vault',
      name: 'Apply blueprints in all notes in vault',
      callback: async () => {
        const root = this.app.vault.getRoot()
        await executeFolderBlueprints(this.app, root, this.suffix)
      },
    })

    this.addCommand({
      id: 'create-blueprint',
      name: 'Create new blueprint',
      callback: () => {
        void createBlueprint(this.app, this.suffix)
      },
    })

    this.addCommand({
      id: 'create-note-from-blueprint',
      name: 'Create new note from blueprint',
      callback: () => {
        void createNoteFromBlueprint(this.app, this.suffix)
      },
    })

    this.addCommand({
      id: 'update-notes-using-blueprint',
      name: 'Update notes using this blueprint',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile()

        if (file && fileIsBlueprint(file, this.suffix)) {
          if (!checking) {
            void updateBlueprintNotes(this.app, file, this.suffix)
          }
          return true
        }

        return false
      },
    })

    this.addCommand({
      id: 'dump-cached-metadata',
      name: "Dump current file's CachedMetadata",
      callback: async () => {
        const file = this.app.workspace.getActiveFile()

        if (file) {
          const cachedMetadata = this.app.metadataCache.getFileCache(file)
          const dumpFileName = `${file.path.replace(/\.md$/, '.json')}`
          try {
            await this.app.vault.create(dumpFileName, JSON.stringify(cachedMetadata, null, 2))
          } catch (_: unknown) {
            const dumpFile = this.app.vault.getFileByPath(dumpFileName)!
            await this.app.vault.modify(dumpFile, JSON.stringify(cachedMetadata, null, 2))
          }
        }
      },
    })

    // A `*.blueprint.md` is markdown and Obsidian already opens it; claiming `md`
    // here would hijack every note in the vault. Only a non-markdown suffix — the
    // legacy `.blueprint` — needs its own registered view.
    const extension = extensionToRegister(this.suffix)

    if (extension) {
      this.registerExtensions([extension], VIEW_TYPE_BLUEPRINT)
      this.registerView(VIEW_TYPE_BLUEPRINT, (leaf) =>
        this.settings.experimentalHasBlueprintSyntaxHighlight
          ? new BlueprintExtendedView(leaf)
          : new BlueprintView(leaf),
      )
    }

    // Experimental Jinja/Nunjucks syntax highlighting for `.blueprint` files. Registered once,
    // unconditionally, as a global editor extension (the supported API) rather than dispatched
    // per file load — so it can never stack across leaf reuse. The extension reads the setting
    // live and is inert unless the editor shows a `.blueprint` file with the feature on, so
    // registering it always (even when off) is safe and lets a runtime toggle take effect via
    // `workspace.updateOptions()` — no app reload needed.
    this.registerEditorExtension(
      blueprintHighlightExtension(() => this.settings.experimentalHasBlueprintSyntaxHighlight),
    )

    this.isReady = true
  }

  onunload() {
    this.isReady = false
  }

  async loadSettings() {
    const stored = (await this.loadData()) as Partial<BlueprintPluginSettings> | null

    // `.blueprint.md` is the default for a *new* install only. A vault that was
    // already using this plugin has `.blueprint` files on disk and no
    // `blueprintSuffix` key; handing it the new default would stop every one of
    // them being recognised — no picker entries, no commands, and no registered
    // handler to open them with. An existing install keeps the legacy suffix
    // until its owner changes it deliberately.
    const isExistingInstall = !!stored && !('blueprintSuffix' in stored)
    const fallback = isExistingInstall ? LEGACY_BLUEPRINT_SUFFIX : DEFAULT_BLUEPRINT_SUFFIX

    this.settings = Object.assign({}, DEFAULT_SETTINGS, { blueprintSuffix: fallback }, stored ?? {})
  }

  async saveSettings() {
    await this.saveData(this.settings)
  }
}
