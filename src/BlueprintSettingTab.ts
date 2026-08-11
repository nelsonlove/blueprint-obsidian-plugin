import { App, PluginSettingTab, Setting } from 'obsidian'
import BlueprintPlugin from './'
import { DEFAULT_BLUEPRINT_SUFFIX, LEGACY_BLUEPRINT_SUFFIX } from './constants'

class BlueprintSettingTab extends PluginSettingTab {
  plugin: BlueprintPlugin

  constructor(app: App, plugin: BlueprintPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    let { containerEl } = this

    containerEl.empty()

    new Setting(containerEl).setName('Blueprint files').setHeading()
    new Setting(containerEl)
      .setName('Blueprint filename suffix')
      .setDesc(
        `How a blueprint is recognised. The default ${DEFAULT_BLUEPRINT_SUFFIX} keeps blueprints ` +
          `as ordinary markdown notes, so they sync, render and open like everything else. ` +
          `Use ${LEGACY_BLUEPRINT_SUFFIX} for standalone files with the plugin's own editor. ` +
          `Existing files are NOT renamed — change this and any file not matching the new ` +
          `suffix stops being treated as a blueprint. Takes effect as soon as you leave the ` +
          `field; opening non-markdown blueprints needs a restart.`,
      )
      .addText((text) => {
        // Committed on blur/Enter, not per keystroke. Every reader resolves the
        // suffix live through `plugin.suffix`, so a half-typed value like `.b` would
        // otherwise be the *active* suffix — and the recognition set it produces is
        // what the self-application guard relies on to know which files are
        // templates. A sweep run mid-edit could then render a template into itself.
        const commit = async () => {
          const value = text.getValue()
          if (value === this.plugin.settings.blueprintSuffix) return
          this.plugin.settings.blueprintSuffix = value
          await this.plugin.saveSettings()
          // The highlighter reads the suffix live but only re-evaluates on a
          // transaction; without this an open file keeps (or lacks) highlighting
          // until some unrelated edit or click happens to wake the editor.
          this.app.workspace.updateOptions()
        }

        text.setPlaceholder(DEFAULT_BLUEPRINT_SUFFIX).setValue(this.plugin.settings.blueprintSuffix)
        text.inputEl.addEventListener('blur', () => void commit())
        text.inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
          if (event.key === 'Enter') void commit()
        })

        return text
      })

    new Setting(containerEl).setName('Experimental features').setHeading()
    new Setting(containerEl)
      .setName('Enable syntax highlighting in Blueprint files')
      .setDesc(
        `Highlights Jinja/Nunjucks tags while editing a blueprint. Works for both file ` +
          `styles: markdown blueprints are highlighted in Obsidian's own editor, and a ` +
          `non-markdown suffix such as ${LEGACY_BLUEPRINT_SUFFIX} in the plugin's.`,
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.experimentalHasBlueprintSyntaxHighlight)
          .onChange(async (value) => {
            this.plugin.settings.experimentalHasBlueprintSyntaxHighlight = value
            await this.plugin.saveSettings()
            // The highlighter extension reads this setting live; reconfigure open editors so the
            // change takes effect immediately on open/new blueprint files without an app reload.
            this.app.workspace.updateOptions()
          }),
      )
  }
}

export { BlueprintSettingTab }
