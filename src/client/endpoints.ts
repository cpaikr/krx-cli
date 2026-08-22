import {
  OPENAPI_ENDPOINTS,
  OPENAPI_OPERATION_PATHS,
} from "../contracts/generated/openapi-registry.js";

export interface ResponseFieldDef {
  readonly name: string;
  readonly description: string;
}

export interface RequestFieldDef {
  readonly name: string;
  readonly type: "string";
  readonly required: true;
}

export interface EndpointDef {
  readonly path: string;
  readonly legacyCommand: string;
  readonly description: string;
  readonly descriptionKo: string;
  readonly category: CategoryId;
  readonly requestFields: readonly RequestFieldDef[];
  readonly responseFields: readonly ResponseFieldDef[];
}

export type CategoryId =
  | "index"
  | "stock"
  | "etp"
  | "bond"
  | "derivative"
  | "commodity"
  | "esg";

export interface CategoryDef {
  readonly id: CategoryId;
  readonly name: string;
  readonly nameKo: string;
  readonly probeEndpoint: string;
}

export const CATEGORIES: readonly CategoryDef[] = [
  {
    id: "index",
    name: "Index",
    nameKo: "지수",
    probeEndpoint: OPENAPI_OPERATION_PATHS.index_kospi_dd_trd,
  },
  {
    id: "stock",
    name: "Stock",
    nameKo: "주식",
    probeEndpoint: OPENAPI_OPERATION_PATHS.stock_stk_bydd_trd,
  },
  {
    id: "etp",
    name: "ETP",
    nameKo: "증권상품",
    probeEndpoint: OPENAPI_OPERATION_PATHS.etp_etf_bydd_trd,
  },
  {
    id: "bond",
    name: "Bond",
    nameKo: "채권",
    probeEndpoint: OPENAPI_OPERATION_PATHS.bond_bnd_bydd_trd,
  },
  {
    id: "derivative",
    name: "Derivative",
    nameKo: "파생상품",
    probeEndpoint: OPENAPI_OPERATION_PATHS.derivative_fut_bydd_trd,
  },
  {
    id: "commodity",
    name: "Commodity",
    nameKo: "일반상품",
    probeEndpoint: OPENAPI_OPERATION_PATHS.commodity_gold_bydd_trd,
  },
  {
    id: "esg",
    name: "ESG",
    nameKo: "ESG",
    probeEndpoint: OPENAPI_OPERATION_PATHS.esg_esg_index_info,
  },
];

export const ENDPOINTS: readonly EndpointDef[] = OPENAPI_ENDPOINTS;

export function getEndpointsByCategory(
  category: CategoryId,
): readonly EndpointDef[] {
  return ENDPOINTS.filter((endpoint) => endpoint.category === category);
}

export function getCategoryById(id: CategoryId): CategoryDef | undefined {
  return CATEGORIES.find((category) => category.id === id);
}
