"use strict";

import { OrderedSet, OrderedMap, Map, Set, Collection, List } from "immutable";
import { defined, panic, assert } from "./Support";
import { TypeGraph } from "./TypeGraph";
import { TypeGraphBuilder, TypeToBe, ArrayTypeToBe, TypeBuilder, MapTypeToBe } from "./TypeBuilder";

export type PrimitiveTypeKind = "any" | "null" | "bool" | "integer" | "double" | "string";
export type NamedTypeKind = "class" | "enum" | "union";
export type TypeKind = PrimitiveTypeKind | NamedTypeKind | "array" | "map";

export abstract class Type {
    constructor(readonly typeGraph: TypeGraph, readonly indexInGraph: number, readonly kind: TypeKind) {}

    isNamedType(): this is NamedType {
        return false;
    }

    abstract get children(): OrderedSet<Type>;

    directlyReachableTypes<T>(setForType: (t: Type) => OrderedSet<T> | null): OrderedSet<T> {
        const set = setForType(this);
        if (set) return set;
        return orderedSetUnion(this.children.map((t: Type) => t.directlyReachableTypes(setForType)));
    }

    abstract get isNullable(): boolean;
    abstract map(builder: TypeBuilder<any>, f: (index: number) => TypeToBe): TypeToBe;

    equals(other: any): boolean {
        if (!Object.prototype.hasOwnProperty.call(other, "indexInGraph")) {
            return false;
        }
        return this.indexInGraph === other.indexInGraph;
    }

    hashCode(): number {
        return this.indexInGraph | 0;
    }
}

export class PrimitiveType extends Type {
    readonly kind: PrimitiveTypeKind;

    constructor(typeGraph: TypeGraph, indexInGraph: number, kind: PrimitiveTypeKind) {
        super(typeGraph, indexInGraph, kind);
    }

    get children(): OrderedSet<Type> {
        return OrderedSet();
    }

    get isNullable(): boolean {
        return this.kind === "null";
    }

    map(builder: TypeBuilder<any>, f: (index: number) => TypeToBe): TypeToBe {
        return builder.getPrimitiveType(this.kind);
    }
}

function isNull(t: Type): t is PrimitiveType {
    return t.kind === "null";
}

export class ArrayType extends Type {
    readonly kind: "array";

    constructor(typeGraph: TypeGraph, indexInGraph: number, private readonly _itemsIndex: number) {
        super(typeGraph, indexInGraph, "array");
    }

    get items(): Type {
        return this.typeGraph.typeAtIndex(this._itemsIndex);
    }

    get children(): OrderedSet<Type> {
        return OrderedSet([this.items]);
    }

    get isNullable(): boolean {
        return false;
    }

    map(builder: TypeBuilder<any>, f: (index: number) => TypeToBe): ArrayTypeToBe {
        return builder.getArrayType(f(this._itemsIndex));
    }
}

export class MapType extends Type {
    readonly kind: "map";

    constructor(typeGraph: TypeGraph, indexInGraph: number, private readonly _valuesIndex: number) {
        super(typeGraph, indexInGraph, "map");
    }

    get values(): Type {
        return this.typeGraph.typeAtIndex(this._valuesIndex);
    }

    get children(): OrderedSet<Type> {
        return OrderedSet([this.values]);
    }

    get isNullable(): boolean {
        return false;
    }

    map(builder: TypeBuilder<any>, f: (index: number) => TypeToBe): MapTypeToBe {
        return builder.getMapType(f(this._valuesIndex));
    }
}

// FIXME: In the case of overlapping prefixes and suffixes we will
// produce a name that includes the overlap twice.  For example, for
// the names "aaa" and "aaaa" we have the common prefix "aaa" and the
// common suffix "aaa", so we will produce the combined name "aaaaaa".
function combineNames(names: Collection<any, string>): string {
    const first = names.first();
    if (first === undefined) {
        return panic("Named type has no names");
    }
    if (names.count() === 1) {
        return first;
    }
    let prefixLength = first.length;
    let suffixLength = first.length;
    names.rest().forEach(n => {
        prefixLength = Math.min(prefixLength, n.length);
        for (let i = 0; i < prefixLength; i++) {
            if (first[i] !== n[i]) {
                prefixLength = i;
                break;
            }
        }

        suffixLength = Math.min(suffixLength, n.length);
        for (let i = 0; i < suffixLength; i++) {
            if (first[first.length - i - 1] !== n[n.length - i - 1]) {
                suffixLength = i;
                break;
            }
        }
    });
    const prefix = prefixLength > 2 ? first.substr(0, prefixLength) : "";
    const suffix = suffixLength > 2 ? first.substr(first.length - suffixLength) : "";
    const combined = prefix + suffix;
    if (combined.length > 2) {
        return combined;
    }
    return first;
}

export type NameOrNames = string | OrderedSet<string>;

function setFromNameOrNames(nameOrNames: NameOrNames): OrderedSet<string> {
    if (typeof nameOrNames === "string") {
        return OrderedSet([nameOrNames]);
    } else {
        return nameOrNames;
    }
}

export abstract class NamedType extends Type {
    private _names: OrderedSet<string>;
    private _areNamesInferred: boolean;

    constructor(
        typeGraph: TypeGraph,
        indexInGraph: number,
        kind: NamedTypeKind,
        nameOrNames: NameOrNames,
        areNamesInferred: boolean
    ) {
        super(typeGraph, indexInGraph, kind);
        this._names = setFromNameOrNames(nameOrNames);
        this._areNamesInferred = areNamesInferred;
    }

    isNamedType(): this is NamedType {
        return true;
    }

    get names(): OrderedSet<string> {
        return this._names;
    }

    get areNamesInferred(): boolean {
        return this._areNamesInferred;
    }

    addNames(nameOrNames: NameOrNames, isInferred: boolean): void {
        if (isInferred && !this._areNamesInferred) {
            return;
        }
        const names = setFromNameOrNames(nameOrNames);
        if (this._areNamesInferred && !isInferred) {
            this._names = names;
            this._areNamesInferred = isInferred;
        } else {
            this._names = this._names.union(names);
        }
    }

    setGivenName(name: string): void {
        this._names = OrderedSet([name]);
        this._areNamesInferred = false;
    }

    get combinedName(): string {
        return combineNames(this._names);
    }
}

export class ClassType extends NamedType {
    kind: "class";

    constructor(
        typeGraph: TypeGraph,
        indexInGraph: number,
        names: NameOrNames,
        areNamesInferred: boolean,
        private _propertyIndexes?: Map<string, number>
    ) {
        super(typeGraph, indexInGraph, "class", names, areNamesInferred);
    }

    setProperties(propertyIndexes: Map<string, number>): void {
        if (this._propertyIndexes !== undefined) {
            return panic("Can only set class properties once");
        }
        this._propertyIndexes = propertyIndexes;
    }

    private getPropertyIndexes(): Map<string, number> {
        if (this._propertyIndexes === undefined) {
            return panic("Class properties accessed before they were set");
        }
        return this._propertyIndexes;
    }

    get properties(): Map<string, Type> {
        return this.getPropertyIndexes().map(this.typeGraph.typeAtIndex);
    }

    get sortedProperties(): OrderedMap<string, Type> {
        const properties = this.properties;
        const sortedKeys = properties.keySeq().sort();
        const props = sortedKeys.map((k: string): [string, Type] => [k, defined(properties.get(k))]);
        return OrderedMap(props);
    }

    get children(): OrderedSet<Type> {
        return this.sortedProperties.toOrderedSet();
    }

    get isNullable(): boolean {
        return false;
    }

    map(builder: TypeBuilder<any>, f: (index: number) => TypeToBe): TypeToBe {
        const properties = this.getPropertyIndexes().map(f);
        return builder.getClassType(this.names, this.areNamesInferred, properties);
    }
}

export class EnumType extends NamedType {
    kind: "enum";

    constructor(
        typeGraph: TypeGraph,
        indexInGraph: number,
        names: NameOrNames,
        areNamesInferred: boolean,
        readonly cases: OrderedSet<string>
    ) {
        super(typeGraph, indexInGraph, "enum", names, areNamesInferred);
    }

    get children(): OrderedSet<Type> {
        return OrderedSet();
    }

    get isNullable(): boolean {
        return false;
    }

    map(builder: TypeBuilder<any>, f: (index: number) => TypeToBe): TypeToBe {
        return builder.getEnumType(this.names, this.areNamesInferred, this.names);
    }
}

export class UnionType extends NamedType {
    kind: "union";

    constructor(
        typeGraph: TypeGraph,
        indexInGraph: number,
        names: NameOrNames,
        areNamesInferred: boolean,
        private readonly _memberIndexes: OrderedSet<number>
    ) {
        super(typeGraph, indexInGraph, "union", names, areNamesInferred);
        assert(_memberIndexes.size > 1, "Union has zero members");
    }

    get members(): OrderedSet<Type> {
        return this._memberIndexes.map(this.typeGraph.typeAtIndex);
    }

    findMember = (kind: TypeKind): Type | undefined => {
        return this.members.find((t: Type) => t.kind === kind);
    };

    get children(): OrderedSet<Type> {
        return this.sortedMembers;
    }

    get isNullable(): boolean {
        return this.findMember("null") !== undefined;
    }

    map(builder: TypeBuilder<any>, f: (index: number) => TypeToBe): TypeToBe {
        const members = this._memberIndexes.map(f);
        return builder.getUnionType(this.names, this.areNamesInferred, members);
    }

    get sortedMembers(): OrderedSet<Type> {
        // FIXME: We're assuming no two members of the same kind.
        return this.members.sortBy(t => t.kind);
    }
}

export function removeNullFromUnion(t: UnionType): [PrimitiveType | null, OrderedSet<Type>] {
    const nullType = t.findMember("null");
    if (!nullType) {
        return [null, t.members];
    }
    return [nullType as PrimitiveType, t.members.filterNot(isNull).toOrderedSet()];
}

export function nullableFromUnion(t: UnionType): Type | null {
    const [hasNull, nonNulls] = removeNullFromUnion(t);
    if (!hasNull) return null;
    if (nonNulls.size !== 1) return null;
    return defined(nonNulls.first());
}

export function nonNullTypeCases(t: Type): Set<Type> {
    if (t.kind === null) {
        return Set();
    }
    if (!(t instanceof UnionType)) {
        return Set([t]);
    }
    const [_, nonNulls] = removeNullFromUnion(t);
    return Set(nonNulls);
}

// FIXME: The outer OrderedSet should be some Collection, but I can't figure out
// which one.  Collection.Indexed doesn't work with OrderedSet, which is unfortunate.
function orderedSetUnion<T>(sets: OrderedSet<OrderedSet<T>>): OrderedSet<T> {
    const setArray = sets.toArray();
    if (setArray.length === 0) return OrderedSet();
    if (setArray.length === 1) return setArray[0];
    return setArray[0].union(...setArray.slice(1));
}

export type SeparatedNamedTypes = {
    classes: OrderedSet<ClassType>;
    enums: OrderedSet<EnumType>;
    unions: OrderedSet<UnionType>;
};

export function separateNamedTypes(types: Collection<any, NamedType>): SeparatedNamedTypes {
    const classes = types.filter((t: NamedType) => t instanceof ClassType).toOrderedSet() as OrderedSet<ClassType>;
    const enums = types.filter((t: NamedType) => t instanceof EnumType).toOrderedSet() as OrderedSet<EnumType>;
    const unions = types.filter((t: NamedType) => t instanceof UnionType).toOrderedSet() as OrderedSet<UnionType>;

    return { classes, enums, unions };
}

export function matchType<U>(
    t: Type,
    anyType: (anyType: PrimitiveType) => U,
    nullType: (nullType: PrimitiveType) => U,
    boolType: (boolType: PrimitiveType) => U,
    integerType: (integerType: PrimitiveType) => U,
    doubleType: (doubleType: PrimitiveType) => U,
    stringType: (stringType: PrimitiveType) => U,
    arrayType: (arrayType: ArrayType) => U,
    classType: (classType: ClassType) => U,
    mapType: (mapType: MapType) => U,
    enumType: (enumType: EnumType) => U,
    unionType: (unionType: UnionType) => U
): U {
    if (t instanceof PrimitiveType) {
        const f = {
            any: anyType,
            null: nullType,
            bool: boolType,
            integer: integerType,
            double: doubleType,
            string: stringType
        }[t.kind];
        if (f) return f(t);
        return panic(`Unknown PrimitiveType: ${t.kind}`);
    } else if (t instanceof ArrayType) return arrayType(t);
    else if (t instanceof ClassType) return classType(t);
    else if (t instanceof MapType) return mapType(t);
    else if (t instanceof EnumType) return enumType(t);
    else if (t instanceof UnionType) return unionType(t);
    return panic("Unknown Type");
}
