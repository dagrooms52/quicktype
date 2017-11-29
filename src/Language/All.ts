import { find, includes } from "lodash";

import { TargetLanguage } from "../TargetLanguage";

import CSharpTargetLanguage from "./csharp/CSharp";
import GoTargetLanguage from "./golang/Golang";
import CPlusPlusTargetLanguage from "./cplusplus/CPlusPlusTargetLanguage";
import JavaTargetLanguage from "./java/Java";
import SimpleTypesTargetLanguage from "./simpletypes/SimpleTypes";
import TypeScriptTargetLanguage from "./typescript/TypeScript";
import SwiftTargetLanguage from "./swift/Swift";
import ElmTargetLanguage from "./elm/Elm";
import JSONSchemaTargetLanguage from "./jsonschema/JSONSchema";

export const all: TargetLanguage[] = [
    new CSharpTargetLanguage(),
    new GoTargetLanguage(),
    new CPlusPlusTargetLanguage(),
    new JavaTargetLanguage(),
    new TypeScriptTargetLanguage(),
    new SwiftTargetLanguage(),
    new ElmTargetLanguage(),
    new JSONSchemaTargetLanguage(),
    new SimpleTypesTargetLanguage()
];

export function languageNamed(name: string): TargetLanguage | undefined {
    return find(all, l => includes(l.names, name) || l.displayName === name);
}
