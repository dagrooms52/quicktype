"use strict";

import * as _ from "lodash";

import { Set, List, Map, OrderedMap, OrderedSet, Collection } from "immutable";

import {
    TopLevels,
    Type,
    PrimitiveType,
    ArrayType,
    MapType,
    EnumType,
    UnionType,
    NamedType,
    ClassType,
    nullableFromUnion,
    removeNullFromUnion,
    matchType
} from "../Type";
import { Source, Sourcelike } from "../Source";
import { utf16LegalizeCharacters, pascalCase, startWithLetter, utf16StringEscape } from "../Strings";
import { intercalate, defined } from "../Support";

import { Namer, Namespace, Name, DependencyName, SimpleName, FixedName, keywordNamespace } from "../Naming";

import { Renderer, RenderResult, BlankLineLocations } from "../Renderer";
import { ConvenienceRenderer } from "../ConvenienceRenderer";

import { TargetLanguage } from "../TargetLanguage";
import { BooleanOption, EnumOption } from "../RendererOptions";

const unicode = require("unicode-properties");

type PythonVersion = "2.7" | "3.4" | "3.5" | "3.6";

export default class PythonTargetLanguage extends TargetLanguage {
    static declareUnionsOption = new BooleanOption("declare-unions", "Declare unions as named types", false);

    constructor() {
        const twoSeven: [string, PythonVersion] = ["2.7", "2.7"];
        const threeFour: [string, PythonVersion] = ["3.4", "3.4"];
        const threeFive: [string, PythonVersion] = ["3.5", "3.5"];
        const threeSix: [string, PythonVersion] = ["3.6", "3.6"];

        const versionOption = new EnumOption<PythonVersion>("python-version", "Target version for Python classes", [
            twoSeven,
            threeFour,
            threeFive,
            threeSix
        ]);

        super("Python", ["python", "py"], "py", [
            PythonTargetLanguage.declareUnionsOption.definition,
            versionOption.definition
        ]);
    }

    renderGraph(topLevels: TopLevels, optionValues: { [name: string]: any }): RenderResult {
        return new PythonRenderer(topLevels, !PythonTargetLanguage.declareUnionsOption.getValue(optionValues)).render();
    }
}

function isStartCharacter(utf16Unit: number): boolean {
    return unicode.isAlphabetic(utf16Unit) || utf16Unit === 0x5f; // underscore
}

function isPartCharacter(utf16Unit: number): boolean {
    const category: string = unicode.getCategory(utf16Unit);
    return _.includes(["Nd", "Pc", "Mn", "Mc"], category) || isStartCharacter(utf16Unit);
}

const legalizeName = utf16LegalizeCharacters(isPartCharacter);

function simpleNameStyle(original: string, uppercase: boolean): string {
    return startWithLetter(isStartCharacter, uppercase, pascalCase(legalizeName(original)));
}

class PythonRenderer extends ConvenienceRenderer {
    constructor(topLevels: TopLevels, private readonly inlineUnions: boolean) {
        super(topLevels);
    }

    protected topLevelNameStyle(rawName: string): string {
        return simpleNameStyle(rawName, true);
    }

    protected get namedTypeNamer(): Namer {
        return new Namer(n => simpleNameStyle(n, true), []);
    }

    protected get propertyNamer(): Namer {
        return new Namer(n => simpleNameStyle(n, false), []);
    }

    protected get caseNamer(): Namer {
        return new Namer(n => simpleNameStyle(n, true), []);
    }

    protected namedTypeToNameForTopLevel(type: Type): NamedType | null {
        if (type.isNamedType()) {
            return type;
        }
        return null;
    }

    sourceFor = (t: Type): Sourcelike => {
        return matchType<Sourcelike>(
            t,
            anyType => "Any",
            nullType => "None",
            boolType => "bool",
            integerType => "int",
            doubleType => "float",
            stringType => "str",
            arrayType => ["List[", this.sourceFor(arrayType.items), "]"],
            classType => this.nameForNamedType(classType),
            mapType => ["Dict[str, ", this.sourceFor(mapType.values), "]"],
            enumType => this.nameForNamedType(enumType),
            unionType => {
                const nullable = nullableFromUnion(unionType);
                if (nullable) return ["Union[", this.sourceFor(nullable), "]"];

                if (this.inlineUnions) {
                    const children = unionType.children.map((c: Type) => this.sourceFor(c));
                    return intercalate(" | ", children).toArray();
                } else {
                    return this.nameForNamedType(unionType);
                }
            }
        );
    };

    private emitClass = (c: ClassType, className: Name) => {
        this.emitLine("class ", className, ":");
        this.indent(() => {
            this.forEachProperty(c, "none", (name, jsonName, t) => {
                this.emitLine(name, ": ", this.sourceFor(t));
            });
        });
        this.emitLine();
    };

    emitEnum = (e: EnumType, enumName: Name) => {
        this.emitLine("class ", enumName, "(Enum):");
        let count = 0;
        this.indent(() => {
            this.forEachCase(e, "none", name => {
                this.emitLine(name, " = ", (count++).toString());
            });
        });
        this.emitLine();
    };

    emitUnion = (u: UnionType, unionName: Name) => {
        this.emitLine("union ", unionName, " {");
        this.indent(() => {
            this.forEach(u.members, false, false, (t: Type) => {
                this.emitLine("case ", this.sourceFor(t));
            });
        });
        this.emitLine("}");
    };

    // Have to reverse class order because Python
    protected forEachSpecificNamedType<T extends NamedType>(
        blankLocations: BlankLineLocations,
        types: OrderedSet<T>,
        f: (t: T, name: Name) => void
    ): void {
        this.forEachWithBlankLines(types.reverse(), blankLocations, t => {
            this.callForNamedType(t, f);
        });
    }

    protected emitSourceStructure() {
        this.forEachEnum("leading-and-interposing", this.emitEnum);
        if (!this.inlineUnions) {
            this.forEachUnion("leading-and-interposing", this.emitUnion);
        }
        this.forEachClass("interposing", this.emitClass);
    }
}
