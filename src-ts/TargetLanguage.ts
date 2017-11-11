"use strict";

import { List } from "immutable";

import * as Either from "Data.Either";

import { Config, TopLevelConfig, GraphQLTopLevelConfig } from "Config";
import * as Main from "Main";
import { Renderer } from "Doc";
import * as Options from "Options";
import { fromLeft, fromRight } from "./purescript";
import { TopLevels } from "./Type";
import { RenderResult } from "./Renderer";
import { OptionDefinition } from "./RendererOptions";
import { glueGraphToNative } from "./Glue";
import { serializeRenderResult, SerializedRenderResult } from "./Source";
import { readGraphQLSchema } from "./GraphQL";

export abstract class TargetLanguage {
    constructor(
        readonly displayName: string,
        readonly names: string[],
        readonly extension: string,
        readonly optionDefinitions: OptionDefinition[]
    ) {}

    abstract transformAndRenderConfig(config: Config): SerializedRenderResult;
}

export abstract class TypeScriptTargetLanguage extends TargetLanguage {
    transformAndRenderConfig(config: Config): SerializedRenderResult {
        let pureScriptTopLevels: TopLevelConfig[] = [];
        let graphQLTopLevels: GraphQLTopLevelConfig[] = [];
        for (const tl of config.topLevels) {
            if (tl.hasOwnProperty("graphQLSchema")) {
                graphQLTopLevels.push(tl as GraphQLTopLevelConfig);
            } else {
                pureScriptTopLevels.push(tl);
            }
        }
        config.topLevels = pureScriptTopLevels;

        const glueGraphOrError = Main.glueGraphFromJsonConfig(config);
        if (Either.isLeft(glueGraphOrError)) {
            throw `Error processing JSON: ${fromLeft(glueGraphOrError)}`;
        }
        const glueGraph = fromRight(glueGraphOrError);
        let graph = glueGraphToNative(glueGraph);
        for (const tl of graphQLTopLevels) {
            graph = graph.set(tl.name, readGraphQLSchema(tl.graphQLSchema, tl.graphQLDocument));
        }
        const renderResult = this.renderGraph(graph, config.rendererOptions);
        return serializeRenderResult(renderResult, this.indentation);
    }

    protected get indentation(): string {
        return "    ";
    }

    protected abstract renderGraph(topLevels: TopLevels, optionValues: { [name: string]: any }): RenderResult;
}

function optionSpecificationToOptionDefinition(spec: Options.OptionSpecification): OptionDefinition {
    const valueType = Options.valueType(spec.default);
    const type = valueType === "BooleanValue" ? Boolean : String;

    let legalValues;
    let defaultValue = spec.default.value0;
    if (valueType === "EnumValue") {
        const { value1 } = spec.default as Options.EnumValue;
        legalValues = value1;
        defaultValue = legalValues[defaultValue as number];
    }

    return {
        name: spec.name,
        description: spec.description,
        typeLabel: spec.typeLabel,
        renderer: true,
        type,
        legalValues,
        defaultValue
    };
}

function optionDefinitionsForRenderer(renderer: Renderer): OptionDefinition[] {
    return renderer.options.map(optionSpecificationToOptionDefinition);
}

export class PureScriptTargetLanguage extends TargetLanguage {
    constructor(renderer: Renderer) {
        const optionDefinitions = optionDefinitionsForRenderer(renderer);
        super(renderer.displayName, renderer.names, renderer.extension, optionDefinitions);
    }

    transformAndRenderConfig(config: Config): SerializedRenderResult {
        // The PureScript rendering pipeline expects option values to be strings.
        // TargetLangauges expect options to be strings or booleans
        // So we stringify the booleans.
        let options = config.rendererOptions;
        config.rendererOptions = {};
        for (let key of Object.keys(options)) {
            config.rendererOptions[key] = options[key].toString();
        }
        config.language = this.names[0];

        const resultOrError = Main.main(config);
        if (Either.isLeft(resultOrError)) {
            throw `Error: ${fromLeft(resultOrError)}`;
        }
        const source = fromRight(resultOrError);
        return { lines: source.split("\n"), annotations: List() };
    }
}
