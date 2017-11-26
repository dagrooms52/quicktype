"use strict";

import { Map, OrderedSet, List, Collection, Set } from "immutable";

import {
    PrimitiveTypeKind,
    Type,
    PrimitiveType,
    NamedType,
    EnumType,
    MapType,
    ArrayType,
    ClassType,
    UnionType,
    NameOrNames,
    removeNullFromUnion
} from "./Type";
import { TypeGraph } from "./TypeGraph";
import { defined, assert, panic } from "./Support";

export type TypeToBe = number;

export abstract class TypeBuilder<TOther> {
    protected readonly typeGraph: TypeGraph = new TypeGraph();

    private _topLevels: Map<string, number> = Map();
    protected types: List<Type | undefined | TOther> = List();

    private _namesToAdd: Map<number, { names: NameOrNames; isInferred: boolean }[]> = Map();

    protected abstract typeForEntry(entry: Type | undefined | TOther): Type | undefined;

    addTopLevel = (name: string, t: Type): void => {
        assert(t.typeGraph === this.typeGraph, "Adding top-level to wrong type graph");
        assert(!this._topLevels.has(name), "Trying to add top-level with existing name");
        this._topLevels = this._topLevels.set(name, t.indexInGraph);
    };

    protected reserveTypeIndex(): number {
        const index = this.types.size;
        this.types = this.types.push(undefined);
        return index;
    }

    protected addType<T extends Type>(creator: (index: number) => T): T {
        const index = this.reserveTypeIndex();
        const t = creator(index);
        assert(this.types.get(index) === undefined, "A type index was committed twice");
        this.types = this.types.set(index, t);
        if (t.isNamedType()) {
            const namesToAdd = this._namesToAdd.get(index);
            if (namesToAdd !== undefined) {
                for (const nta of namesToAdd) {
                    t.addNames(nta.names, nta.isInferred);
                }
                this._namesToAdd = this._namesToAdd.remove(index);
            }
        }
        return t;
    }

    protected addNames = (typeIndex: number, names: NameOrNames, isInferred: boolean): void => {
        const t = this.typeForEntry(this.types.get(typeIndex));
        if (t !== undefined) {
            if (!t.isNamedType()) {
                return panic("Trying to give names to unnamed type");
            }
            t.addNames(names, isInferred);
        } else {
            let entries = this._namesToAdd.get(typeIndex);
            if (entries === undefined) {
                entries = [];
                this._namesToAdd = this._namesToAdd.set(typeIndex, entries);
            }
            entries.push({ names, isInferred });
        }
    };

    finish = (): TypeGraph => {
        assert(this._namesToAdd.isEmpty(), "We're finishing, but still names to add left");
        this.typeGraph.freeze(this._topLevels, this.types.map(t => defined(this.typeForEntry(t))));
        return this.typeGraph;
    };

    abstract getPrimitiveType(kind: PrimitiveTypeKind): TypeToBe;
    abstract getEnumType(names: NameOrNames, isInferred: boolean, cases: OrderedSet<string>): TypeToBe;
    abstract getMapType(values: TypeToBe): TypeToBe;
    abstract getArrayType(items: TypeToBe): TypeToBe;
    abstract getClassType(names: NameOrNames, isInferred: boolean, properties: Map<string, TypeToBe>): TypeToBe;
    abstract getUnionType(names: NameOrNames, isInferred: boolean, members: OrderedSet<TypeToBe>): TypeToBe;

    makeNullable = (index: TypeToBe, typeNames: NameOrNames, areNamesInferred: boolean): TypeToBe => {
        const t = defined(this.typeForEntry(this.types.get(index)));
        if (t.kind === "null") {
            return index;
        }
        const nullType = this.getPrimitiveType("null");
        if (!(t instanceof UnionType)) {
            return this.getUnionType(typeNames, areNamesInferred, OrderedSet([index, nullType]));
        }
        const [maybeNull, nonNulls] = removeNullFromUnion(t);
        if (maybeNull) return index;
        return this.getUnionType(typeNames, areNamesInferred, nonNulls.map(nn => nn.indexInGraph).add(nullType));
    };
}

export abstract class CoalescingTypeBuilder<TOther> extends TypeBuilder<TOther> {
    // FIXME: make mutable?
    private _primitiveTypes: Map<PrimitiveTypeKind, TypeToBe> = Map();
    private _mapTypes: Map<TypeToBe, TypeToBe> = Map();
    private _arrayTypes: Map<TypeToBe, TypeToBe> = Map();
    private _enumTypes: Map<OrderedSet<string>, TypeToBe> = Map();
    private _classTypes: Map<Map<string, TypeToBe>, TypeToBe> = Map();
    private _unionTypes: Map<OrderedSet<TypeToBe>, TypeToBe> = Map();

    getPrimitiveType(kind: PrimitiveTypeKind): TypeToBe {
        let index = this._primitiveTypes.get(kind);
        if (index === undefined) {
            index = this.addType(i => new PrimitiveType(this.typeGraph, i, kind)).indexInGraph;
            this._primitiveTypes = this._primitiveTypes.set(kind, index);
        }
        return index;
    }

    getEnumType(names: NameOrNames, isInferred: boolean, cases: OrderedSet<string>): TypeToBe {
        let index = this._enumTypes.get(cases);
        if (index === undefined) {
            index = this.addType(i => new EnumType(this.typeGraph, i, names, isInferred, cases)).indexInGraph;
            this._enumTypes = this._enumTypes.set(cases, index);
        } else {
            this.addNames(index, names, isInferred);
        }
        return index;
    }

    getMapType(values: TypeToBe): TypeToBe {
        let index = this._mapTypes.get(values);
        if (index === undefined) {
            index = this.addType(i => new MapType(this.typeGraph, i, values)).indexInGraph;
            this._mapTypes = this._mapTypes.set(values, index);
        }
        return index;
    }

    getArrayType(items: TypeToBe): TypeToBe {
        let index = this._arrayTypes.get(items);
        if (index === undefined) {
            index = this.addType(i => new ArrayType(this.typeGraph, i, items)).indexInGraph;
            this._arrayTypes = this._arrayTypes.set(items, index);
        }
        return index;
    }

    getClassType(names: NameOrNames, isInferred: boolean, properties: Map<string, TypeToBe>): TypeToBe {
        let index = this._classTypes.get(properties);
        if (index === undefined) {
            const t = this.addType(i => new ClassType(this.typeGraph, i, names, isInferred, properties));
            index = t.indexInGraph;
            this._classTypes = this._classTypes.set(properties, index);
        } else {
            this.addNames(index, names, isInferred);
        }
        return index;
    }

    getUnionType(names: NameOrNames, isInferred: boolean, members: OrderedSet<TypeToBe>): TypeToBe {
        let index = this._unionTypes.get(members);
        if (index === undefined) {
            const t = this.addType(i => new UnionType(this.typeGraph, i, names, isInferred, members));
            index = t.indexInGraph;
            this._unionTypes = this._unionTypes.set(members, index);
        } else {
            this.addNames(index, names, isInferred);
        }
        return index;
    }
}

export class TypeGraphBuilder extends CoalescingTypeBuilder<void> {
    protected typeForEntry(entry: Type | undefined): Type | undefined {
        return entry;
    }

    getUniqueClassType = (names: NameOrNames, isInferred: boolean, properties?: Map<string, TypeToBe>): TypeToBe => {
        return this.addType(index => new ClassType(this.typeGraph, index, names, isInferred, properties)).indexInGraph;
    };

    getUniqueUnionType = (name: string, isInferred: boolean, members: OrderedSet<TypeToBe>): TypeToBe => {
        return this.addType(index => new UnionType(this.typeGraph, index, name, isInferred, members)).indexInGraph;
    };
}

export class GraphRewriteBuilder extends CoalescingTypeBuilder<number> {
    private _setsToReplaceByMember: Map<number, Set<number>>;
    private _reconstitutedTypes: Map<number, TypeToBe> = Map();

    constructor(
        private readonly _originalGraph: TypeGraph,
        setsToReplace: Type[][],
        private readonly _replacer: (typesToReplace: Set<number>, builder: GraphRewriteBuilder) => TypeToBe
    ) {
        super();
        this._setsToReplaceByMember = Map();
        for (const types of setsToReplace) {
            const set = Set(types.map(t => t.indexInGraph));
            set.forEach(index => {
                assert(!this._setsToReplaceByMember.has(index), "A type is member of more than one set to be replaced");
                this._setsToReplaceByMember = this._setsToReplaceByMember.set(index, set);
            });
        }
    }

    protected typeForEntry(entry: Type | undefined | number): Type | undefined {
        if (typeof entry === "number") {
            return this.typeForEntry(this.types.get(entry));
        }
        return entry;
    }

    private withForwardingIndex(typeCreator: (forwardingIndex: number) => number): number {
        const forwardingIndex = this.reserveTypeIndex();
        const actualIndex = typeCreator(forwardingIndex);
        assert(this.types.get(forwardingIndex) === undefined, "Forwarding slow should not be set");
        this.types = this.types.set(forwardingIndex, actualIndex);
        return actualIndex;
    }

    private replaceSet(typesToReplace: Set<number>): TypeToBe {
        return this.withForwardingIndex(forwardingIndex => {
            typesToReplace.forEach(originalIndex => {
                this._reconstitutedTypes = this._reconstitutedTypes.set(originalIndex, forwardingIndex);
                this._setsToReplaceByMember = this._setsToReplaceByMember.remove(originalIndex);
            });
            return this._replacer(typesToReplace, this);
        });
    }

    private getReconstitutedType = (originalIndex: number): TypeToBe => {
        const maybeTypeToBe = this._reconstitutedTypes.get(originalIndex);
        if (maybeTypeToBe !== undefined) {
            return maybeTypeToBe;
        }
        const maybeSet = this._setsToReplaceByMember.get(originalIndex);
        if (maybeSet !== undefined) {
            return this.replaceSet(maybeSet);
        }
        return this.withForwardingIndex(forwardingIndex => {
            this._reconstitutedTypes = this._reconstitutedTypes.set(originalIndex, forwardingIndex);
            return this._originalGraph.typeAtIndex(originalIndex).map(this, this.getReconstitutedType);
        });
    };
}

export abstract class UnionBuilder<TArray, TClass, TMap> {
    private _haveAny = false;
    private _haveNull = false;
    private _haveBool = false;
    private _haveInteger = false;
    private _haveDouble = false;
    private _haveString = false;
    private readonly _arrays: TArray[] = [];
    private readonly _maps: TMap[] = [];
    private readonly _classes: TClass[] = [];
    private _enumCaseMap: { [name: string]: number } = {};
    private _enumCases: string[] = [];

    constructor(
        protected readonly typeBuilder: TypeGraphBuilder,
        protected readonly typeName: string,
        protected readonly isInferred: boolean
    ) {}

    get haveString(): boolean {
        return this._haveString;
    }

    addAny = (): void => {
        this._haveAny = true;
    };
    addNull = (): void => {
        this._haveNull = true;
    };
    addBool = (): void => {
        this._haveBool = true;
    };
    addInteger = (): void => {
        this._haveInteger = true;
    };
    addDouble = (): void => {
        this._haveDouble = true;
    };

    addString = (): void => {
        if (!this._haveString) {
            this._haveString = true;
            this._enumCaseMap = {};
            this._enumCases = [];
        }
    };
    addArray = (t: TArray): void => {
        this._arrays.push(t);
    };
    addClass = (t: TClass): void => {
        this._classes.push(t);
    };
    addMap = (t: TMap): void => {
        this._maps.push(t);
    };

    addEnumCase = (s: string): void => {
        if (this._haveString) {
            return;
        }
        if (!Object.prototype.hasOwnProperty.call(this._enumCaseMap, s)) {
            this._enumCaseMap[s] = 0;
            this._enumCases.push(s);
        }
        this._enumCaseMap[s] += 1;
    };

    protected abstract makeEnum(cases: string[]): TypeToBe | null;
    protected abstract makeClass(classes: TClass[], maps: TMap[]): TypeToBe;
    protected abstract makeArray(arrays: TArray[]): TypeToBe;

    buildUnion = (unique: boolean): TypeToBe => {
        const types: TypeToBe[] = [];

        if (this._haveAny) {
            return this.typeBuilder.getPrimitiveType("any");
        }
        if (this._haveNull) {
            types.push(this.typeBuilder.getPrimitiveType("null"));
        }
        if (this._haveBool) {
            types.push(this.typeBuilder.getPrimitiveType("bool"));
        }
        if (this._haveDouble) {
            types.push(this.typeBuilder.getPrimitiveType("double"));
        } else if (this._haveInteger) {
            types.push(this.typeBuilder.getPrimitiveType("integer"));
        }
        if (this._haveString) {
            types.push(this.typeBuilder.getPrimitiveType("string"));
        } else if (this._enumCases.length > 0) {
            const maybeEnum = this.makeEnum(this._enumCases);
            if (maybeEnum !== null) {
                types.push(maybeEnum);
            } else {
                types.push(this.typeBuilder.getPrimitiveType("string"));
            }
        }
        if (this._classes.length > 0 || this._maps.length > 0) {
            types.push(this.makeClass(this._classes, this._maps));
        }
        if (this._arrays.length > 0) {
            types.push(this.makeArray(this._arrays));
        }

        if (types.length === 0) {
            return this.typeBuilder.getPrimitiveType("any");
        }
        if (types.length === 1) {
            return types[0];
        }
        const typesSet = OrderedSet(types);
        if (unique) {
            return this.typeBuilder.getUniqueUnionType(this.typeName, this.isInferred, typesSet);
        } else {
            return this.typeBuilder.getUnionType(this.typeName, this.isInferred, typesSet);
        }
    };
}
