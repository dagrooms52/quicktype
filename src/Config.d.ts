export type Json = object;
export type IRTypeable = Json | string;

export type GraphQLTopLevelConfig = {
  name: string;
  graphQLSchema: any;
  graphQLDocument: string;
};

export type TopLevelConfig =
  | { name: string; samples: IRTypeable[] }
  | { name: string; schema: Json }
  | GraphQLTopLevelConfig;

export interface Config {
  language: string;
  topLevels: TopLevelConfig[];
  inferMaps: boolean;
  rendererOptions: { [name: string]: any };
}
