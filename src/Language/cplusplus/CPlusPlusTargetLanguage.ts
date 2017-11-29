"use strict";

import { TargetLanguage } from "../../TargetLanguage";
import { Type, TopLevels } from "../../Type";
import { RenderResult } from "../../Renderer";
import { StringOption, EnumOption } from "../../RendererOptions";
import CPlusPlusRenderer from "./CPlusPlusRenderer";
import { NamingStyle } from "./Common";

export default class CPlusPlusTargetLanguage extends TargetLanguage {
    private readonly _namespaceOption: StringOption;
    private readonly _typeNamingStyleOption: EnumOption<NamingStyle>;
    private readonly _memberNamingStyleOption: EnumOption<NamingStyle>;
    private readonly _enumeratorNamingStyleOption: EnumOption<NamingStyle>;
    private readonly _uniquePtrOption: EnumOption<boolean>;

    constructor() {
        const namespaceOption = new StringOption("namespace", "Name of the generated namespace", "NAME", "quicktype");
        const pascalValue: [string, NamingStyle] = ["pascal-case", "pascal"];
        const underscoreValue: [string, NamingStyle] = ["underscore-case", "underscore"];
        const camelValue: [string, NamingStyle] = ["camel-case", "camel"];
        const upperUnderscoreValue: [string, NamingStyle] = ["upper-underscore-case", "upper-underscore"];
        const typeNamingStyleOption = new EnumOption<NamingStyle>("type-style", "Naming style for types", [
            pascalValue,
            underscoreValue,
            camelValue,
            upperUnderscoreValue
        ]);
        const memberNamingStyleOption = new EnumOption<NamingStyle>("member-style", "Naming style for members", [
            underscoreValue,
            pascalValue,
            camelValue,
            upperUnderscoreValue
        ]);
        const enumeratorNamingStyleOption = new EnumOption<NamingStyle>(
            "enumerator-style",
            "Naming style for enumerators",
            [upperUnderscoreValue, underscoreValue, pascalValue, camelValue]
        );
        const uniquePtrOption = new EnumOption("unions", "Use containment or indirection for unions", [
            ["containment", false],
            ["indirection", true]
        ]);
        super("C++", ["c++", "cpp", "cplusplus"], "cpp", [
            namespaceOption.definition,
            typeNamingStyleOption.definition,
            memberNamingStyleOption.definition,
            enumeratorNamingStyleOption.definition,
            uniquePtrOption.definition
        ]);
        this._namespaceOption = namespaceOption;
        this._typeNamingStyleOption = typeNamingStyleOption;
        this._memberNamingStyleOption = memberNamingStyleOption;
        this._enumeratorNamingStyleOption = enumeratorNamingStyleOption;
        this._uniquePtrOption = uniquePtrOption;
    }

    renderGraph(topLevels: TopLevels, optionValues: { [name: string]: any }): RenderResult {
        const renderer = new CPlusPlusRenderer(
            topLevels,
            this._namespaceOption.getValue(optionValues),
            this._typeNamingStyleOption.getValue(optionValues),
            this._memberNamingStyleOption.getValue(optionValues),
            this._enumeratorNamingStyleOption.getValue(optionValues),
            this._uniquePtrOption.getValue(optionValues)
        );
        return renderer.render();
    }
}
