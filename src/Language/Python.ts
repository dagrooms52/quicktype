import { TargetLanguage } from "../TargetLanguage";
import { TopLevels } from "../Type";
import { RenderResult } from "../Renderer";

export default class PythonTargetLanguage extends TargetLanguage {
    
    constructor() {
        super("Python", ["py", "python"], "py", );
    }
    
    renderGraph(topLevels: TopLevels, optionValues: { [name: string]: any }): RenderResult {
        const { helpers, attributes } = this._featuresOption.getValue(optionValues);
        const renderer = new PythonRenderer(
            topLevels,
            this._listOption.getValue(optionValues),
            this._denseOption.getValue(optionValues),
            helpers,
            attributes,
            this._namespaceOption.getValue(optionValues),
            this._versionOption.getValue(optionValues)
        );
        return renderer.render();
    }
}