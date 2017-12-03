"use strict";

import { List, OrderedSet, Map, OrderedMap, fromJS, Set, isIndexed } from "immutable";
import * as pluralize from "pluralize";

import { Type, ClassType, NameOrNames, matchType, EnumType, MapType } from "./Type";
import { panic, assertNever, StringMap, checkStringMap, assert, defined } from "./Support";
import { TypeGraph } from "./TypeGraph";
import { UnionBuilder, TypeGraphBuilder, TypeRef } from "./TypeBuilder";
import { getHashes } from "crypto";

enum PathElementKind {
    Root,
    Definition,
    OneOf,
    Property,
    AdditionalProperty,
    Items
}

type PathElement =
    | { kind: PathElementKind.Root }
    | { kind: PathElementKind.Definition; name: string }
    | { kind: PathElementKind.OneOf; index: number }
    | { kind: PathElementKind.Property; name: string }
    | { kind: PathElementKind.AdditionalProperty }
    | { kind: PathElementKind.Items };

type Ref = List<PathElement>;

function checkStringArray(arr: any): string[] {
    if (!Array.isArray(arr)) {
        return panic(`Expected a string array, but got ${arr}`);
    }
    for (const e of arr) {
        if (typeof e !== "string") {
            return panic(`Expected string, but got ${e}`);
        }
    }
    return arr;
}

function parseRef(ref: any): [Ref, string] {
    if (typeof ref !== "string") {
        return panic("$ref must be a string");
    }

    let refName = "Something";

    const parts = ref.split("/");
    const elements: PathElement[] = [];
    for (let i = 0; i < parts.length; i++) {
        if (parts[i] === "#") {
            elements.push({ kind: PathElementKind.Root });
            refName = "Root";
        } else if (parts[i] === "definitions" && i + 1 < parts.length) {
            refName = parts[i + 1];
            elements.push({ kind: PathElementKind.Definition, name: refName });
            i += 1;
        } else {
            panic(`Could not parse JSON schema reference ${ref}`);
        }
    }
    return [List(elements), refName];
}

function lookupDefinition(schema: StringMap, name: string): StringMap {
    const definitions = checkStringMap(schema.definitions);
    return checkStringMap(definitions[name]);
}

function lookupProperty(schema: StringMap, name: string): StringMap {
    const properties = checkStringMap(schema.properties);
    return checkStringMap(properties[name]);
}

function indexOneOf(schema: StringMap, index: number): StringMap {
    const cases = schema.oneOf;
    if (!Array.isArray(cases)) {
        return panic("oneOf value must be an array");
    }
    return checkStringMap(cases[index]);
}

function getName(schema: StringMap, name: string, isInferred: boolean): [string, boolean] {
    if (!isInferred) {
        return [name, false];
    }
    const title = schema.title;
    if (typeof title === "string") {
        return [title, false];
    } else {
        return [name, true];
    }
}

function checkTypeList(typeOrTypes: any): OrderedSet<string> {
    if (typeof typeOrTypes === "string") {
        return OrderedSet([typeOrTypes]);
    } else if (Array.isArray(typeOrTypes)) {
        const arr: string[] = [];
        for (const t of typeOrTypes) {
            if (typeof t !== "string") {
                return panic(`element of type is not a string: ${t}`);
            }
            arr.push(t);
        }
        const set = OrderedSet(arr);
        assert(!set.isEmpty(), "JSON Schema must specify at least one type");
        return set;
    } else {
        return panic(`type is neither a string or array of strings: ${typeOrTypes}`);
    }
}

// Here's a case we can't handle: If the schema specifies
// types
//
//   Foo = class { x: Bar }
//   Bar = Foo | Quux
//   Quux = class { ... }
//
// then to resolve the properties of `Foo` we have to know
// the properties of `Bar`, but to resolve those we have to
// know the properties of `Foo`.
function getHopefullyFinishedType(builder: TypeGraphBuilder, t: TypeRef): Type {
    const result = builder.lookupType(t);
    if (result === undefined) {
        return panic("Inconveniently recursive types in schema");
    }
    return result;
}

function assertIsClass(t: Type): ClassType {
    if (!(t instanceof ClassType)) {
        return panic("Supposed class type is not a class type");
    }
    return t;
}

function makeImmutablePath(path: Ref): List<any> {
    return path.map(pe => fromJS(pe));
}

class UnifyUnionBuilder extends UnionBuilder<TypeRef, TypeRef, TypeRef> {
    constructor(
        typeBuilder: TypeGraphBuilder,
        typeName: string,
        isInferred: boolean,
        private readonly _unifyTypes: (typesToUnify: TypeRef[], typeName: string, isInferred: boolean) => TypeRef
    ) {
        super(typeBuilder, typeName, isInferred);
    }

    protected makeEnum(enumCases: string[]): TypeRef {
        return this.typeBuilder.getEnumType(this.typeName, this.isInferred, OrderedSet(enumCases));
    }

    protected makeClass(classes: TypeRef[], maps: TypeRef[]): TypeRef {
        if (classes.length > 0 && maps.length > 0) {
            return panic("Cannot handle a class type that's also a map");
        }
        if (maps.length > 0) {
            return this.typeBuilder.getMapType(this._unifyTypes(maps, this.typeName, this.isInferred));
        }
        if (classes.length === 1) {
            return classes[0];
        }
        let properties = OrderedMap<string, TypeRef[]>();
        const actualClasses: ClassType[] = [];
        for (const c of classes) {
            const t = assertIsClass(getHopefullyFinishedType(this.typeBuilder, c));
            actualClasses.push(t);
        }
        for (const c of actualClasses) {
            c.properties.forEach((t, name) => {
                const types = properties.get(name);
                if (types === undefined) {
                    properties = properties.set(name, [t.typeRef]);
                } else {
                    types.push(t.typeRef);
                }
            });
        }
        return this.typeBuilder.getUniqueClassType(
            this.typeName,
            this.isInferred,
            properties.map((ts, name) => this._unifyTypes(ts, name, true))
        );
    }

    protected makeArray(arrays: TypeRef[]): TypeRef {
        return this.typeBuilder.getArrayType(this._unifyTypes(arrays, pluralize.singular(this.typeName), true));
    }
}

export function schemaToType(typeBuilder: TypeGraphBuilder, topLevelName: string, rootJson: any): TypeRef {
    const root = checkStringMap(rootJson);
    let typeForPath = Map<List<any>, TypeRef>();

    function setTypeForPath(path: Ref, t: TypeRef): void {
        typeForPath = typeForPath.set(makeImmutablePath(path), t);
    }

    function unifyTypes(typesToUnify: TypeRef[], typeName: string, isInferred: boolean): TypeRef {
        if (typesToUnify.length === 0) {
            return panic("Cannot unify empty list of types");
        } else if (typesToUnify.length === 1) {
            return typesToUnify[0];
        } else {
            const unionBuilder = new UnifyUnionBuilder(typeBuilder, typeName, isInferred, unifyTypes);

            const registerType = (t: Type): void => {
                matchType<void>(
                    t,
                    anyType => unionBuilder.addAny(),
                    nullType => unionBuilder.addNull(),
                    boolType => unionBuilder.addBool(),
                    integerType => unionBuilder.addInteger(),
                    doubleType => unionBuilder.addDouble(),
                    stringType => unionBuilder.addString(),
                    arrayType => unionBuilder.addArray(arrayType.items.typeRef),
                    classType => unionBuilder.addClass(classType.typeRef),
                    mapType => unionBuilder.addMap(mapType.values.typeRef),
                    enumType => enumType.cases.forEach(s => unionBuilder.addEnumCase(s)),
                    unionType => unionType.members.forEach(registerType)
                );
            };

            for (const t of typesToUnify) {
                registerType(getHopefullyFinishedType(typeBuilder, t));
            }

            return unionBuilder.buildUnion(false);
        }
    }

    function lookupRef(local: StringMap, localPath: Ref, ref: Ref): [StringMap, Ref] {
        const first = ref.first();
        if (first === undefined) {
            return [local, localPath];
        }
        const rest = ref.rest();
        if (first.kind === PathElementKind.Root) {
            return lookupRef(root, List([first]), ref.rest());
        }
        localPath = localPath.push(first);
        switch (first.kind) {
            case PathElementKind.Definition:
                return lookupRef(lookupDefinition(local, first.name), localPath, rest);
            case PathElementKind.OneOf:
                return lookupRef(indexOneOf(local, first.index), localPath, rest);
            case PathElementKind.Property:
                return lookupRef(lookupProperty(local, first.name), localPath, rest);
            case PathElementKind.AdditionalProperty:
                return lookupRef(checkStringMap(local.additionalProperties), localPath, rest);
            case PathElementKind.Items:
                return lookupRef(checkStringMap(local.items), localPath, rest);
            default:
                return assertNever(first);
        }
    }

    function makeClass(
        schema: StringMap,
        path: Ref,
        name: string,
        isInferred: boolean,
        properties: StringMap,
        requiredArray: string[]
    ): TypeRef {
        const required = Set(requiredArray);
        [name, isInferred] = getName(schema, name, isInferred);
        const result = typeBuilder.getUniqueClassType(name, isInferred);
        const c = assertIsClass(getHopefullyFinishedType(typeBuilder, result));
        setTypeForPath(path, result);
        const props = Map(properties).map((propSchema, propName) => {
            let t = toType(
                checkStringMap(propSchema),
                path.push({ kind: PathElementKind.Property, name: propName }),
                pluralize.singular(propName),
                true
            );
            if (!required.has(propName)) {
                return typeBuilder.makeNullable(t, propName, true);
            }
            return t;
        });
        c.setProperties(props);
        return result;
    }

    function makeMap(path: Ref, name: string, additional: StringMap): TypeRef {
        let valuesType: TypeRef | undefined = undefined;
        let mustSet = false;
        const result = typeBuilder.getLazyMapType(() => {
            mustSet = true;
            return valuesType;
        });
        setTypeForPath(path, result);
        path = path.push({ kind: PathElementKind.AdditionalProperty });
        valuesType = toType(additional, path, pluralize.singular(name), true);
        if (mustSet) {
            (result.deref() as MapType).setValues(valuesType);
        }
        return result;
    }

    function fromTypeName(schema: StringMap, path: Ref, inferredName: string, typeName: string): TypeRef {
        const [name, isInferred] = getName(schema, inferredName, true);
        switch (typeName) {
            case "object":
                let required: string[];
                if (schema.required === undefined) {
                    required = [];
                } else {
                    required = checkStringArray(schema.required);
                }
                if (schema.properties !== undefined) {
                    return makeClass(schema, path, name, isInferred, checkStringMap(schema.properties), required);
                } else if (schema.additionalProperties !== undefined) {
                    const additional = schema.additionalProperties;
                    if (additional === true) {
                        return typeBuilder.getMapType(typeBuilder.getPrimitiveType("any"));
                    } else if (additional === false) {
                        return makeClass(schema, path, name, isInferred, {}, required);
                    } else {
                        return makeMap(path, name, checkStringMap(additional));
                    }
                } else {
                    return typeBuilder.getMapType(typeBuilder.getPrimitiveType("any"));
                }
            case "array":
                if (schema.items !== undefined) {
                    path = path.push({ kind: PathElementKind.Items });
                    return typeBuilder.getArrayType(
                        toType(checkStringMap(schema.items), path, pluralize.singular(name), true)
                    );
                }
                return typeBuilder.getArrayType(typeBuilder.getPrimitiveType("any"));
            case "boolean":
                return typeBuilder.getPrimitiveType("bool");
            case "string":
                return typeBuilder.getPrimitiveType("string");
            case "null":
                return typeBuilder.getPrimitiveType("null");
            case "integer":
                return typeBuilder.getPrimitiveType("integer");
            case "number":
                return typeBuilder.getPrimitiveType("double");
            default:
                return panic(`not a type name: ${typeName}`);
        }
    }

    function convertToType(schema: StringMap, path: Ref, name: string, isInferred: boolean): TypeRef {
        [name, isInferred] = getName(schema, name, isInferred);
        if (schema.$ref !== undefined) {
            const [ref, refName] = parseRef(schema.$ref);
            const [target, targetPath] = lookupRef(schema, path, ref);
            return toType(target, targetPath, isInferred ? refName : name, isInferred);
        } else if (schema.enum !== undefined) {
            return typeBuilder.getEnumType(name, isInferred, OrderedSet(checkStringArray(schema.enum)));
        } else if (schema.type !== undefined) {
            const typeNames = checkTypeList(schema.type);
            if (typeNames.size === 1) {
                return fromTypeName(schema, path, name, defined(typeNames.first()));
            } else {
                const types = typeNames.map(n => fromTypeName(schema, path, name, n));
                return unifyTypes(types.toArray(), name, isInferred);
            }
        } else if (schema.oneOf !== undefined) {
            const oneOf = schema.oneOf;
            if (!Array.isArray(oneOf)) {
                return panic(`oneOf is not an array: ${schema.oneOf}`);
            }
            const types = oneOf.map((t, index) =>
                toType(checkStringMap(t), path.push({ kind: PathElementKind.OneOf, index }), name, true)
            );
            return unifyTypes(types, name, isInferred);
        } else {
            return typeBuilder.getPrimitiveType("any");
        }
    }

    function toType(schema: StringMap, path: Ref, name: string, isInferred: boolean): TypeRef {
        // FIXME: This fromJS thing is ugly and inefficient.  Schemas aren't
        // big, so it most likely doesn't matter.
        const immutablePath = makeImmutablePath(path);
        const maybeType = typeForPath.get(immutablePath);
        if (maybeType !== undefined) {
            return maybeType;
        }
        const result = convertToType(schema, path, name, isInferred);
        setTypeForPath(immutablePath, result);
        return result;
    }

    const rootPathElement: PathElement = { kind: PathElementKind.Root };
    const rootType = toType(root, List<PathElement>([rootPathElement]), topLevelName, false);
    return rootType;
}
