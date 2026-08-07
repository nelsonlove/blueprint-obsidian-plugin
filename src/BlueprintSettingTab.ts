import { App, PluginSettingTab, Setting } from 'obsidian'
import BlueprintPlugin from './'

class BlueprintSettingTab extends PluginSettingTab {
  plugin: BlueprintPlugin

  constructor(app: App, plugin: BlueprintPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    let { containerEl } = this

    containerEl.empty()

    new Setting(containerEl).setName('Experimental features').setHeading()
    new Setting(containerEl)
      .setName('Enable syntax highlighting in Blueprint files')
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
