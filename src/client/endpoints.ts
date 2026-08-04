import { RESPONSE_FIELDS, type ResponseFieldDef } from "./response-fields.js";

export type { ResponseFieldDef };

export interface RequestFieldDef {
  readonly name: string;
  readonly type: "string";
  readonly required: true;
}

export interface EndpointDef {
  readonly path: string;
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
  readonly code: string;
  readonly name: string;
  readonly nameKo: string;
  readonly probeEndpoint: string;
}

export const CATEGORIES: readonly CategoryDef[] = [
  {
    id: "index",
    code: "idx",
    name: "Index",
    nameKo: "지수",
    probeEndpoint: "/svc/apis/idx/kospi_dd_trd",
  },
  {
    id: "stock",
    code: "sto",
    name: "Stock",
    nameKo: "주식",
    probeEndpoint: "/svc/apis/sto/stk_bydd_trd",
  },
  {
    id: "etp",
    code: "etp",
    name: "ETP",
    nameKo: "증권상품",
    probeEndpoint: "/svc/apis/etp/etf_bydd_trd",
  },
  {
    id: "bond",
    code: "bon",
    name: "Bond",
    nameKo: "채권",
    probeEndpoint: "/svc/apis/bon/bnd_bydd_trd",
  },
  {
    id: "derivative",
    code: "drv",
    name: "Derivative",
    nameKo: "파생상품",
    probeEndpoint: "/svc/apis/drv/fut_bydd_trd",
  },
  {
    id: "commodity",
    code: "gen",
    name: "Commodity",
    nameKo: "일반상품",
    probeEndpoint: "/svc/apis/gen/gold_bydd_trd",
  },
  {
    id: "esg",
    code: "esg",
    name: "ESG",
    nameKo: "ESG",
    probeEndpoint: "/svc/apis/esg/esg_index_info",
  },
] as const;

function ep(
  path: string,
  description: string,
  descriptionKo: string,
  category: CategoryId,
): EndpointDef {
  return {
    path,
    description,
    descriptionKo,
    category,
    requestFields: [{ name: "basDd", type: "string", required: true }],
    responseFields: RESPONSE_FIELDS[path] ?? [],
  };
}

export const ENDPOINTS: readonly EndpointDef[] = [
  // Index (idx)
  ep(
    "/svc/apis/idx/krx_dd_trd",
    "KRX series index daily trading",
    "KRX 시리즈 지수 일별시세",
    "index",
  ),
  ep(
    "/svc/apis/idx/kospi_dd_trd",
    "KOSPI series index daily trading",
    "KOSPI 시리즈 지수 일별시세",
    "index",
  ),
  ep(
    "/svc/apis/idx/kosdaq_dd_trd",
    "KOSDAQ series index daily trading",
    "KOSDAQ 시리즈 지수 일별시세",
    "index",
  ),
  ep(
    "/svc/apis/idx/bon_dd_trd",
    "Bond index daily trading",
    "채권지수 일별시세",
    "index",
  ),
  ep(
    "/svc/apis/idx/drvprod_dd_trd",
    "Derivatives index daily trading",
    "파생상품지수 일별시세",
    "index",
  ),

  // Stock (sto)
  ep(
    "/svc/apis/sto/stk_bydd_trd",
    "KOSPI stock daily trading",
    "유가증권(KOSPI) 주식 일별매매정보",
    "stock",
  ),
  ep(
    "/svc/apis/sto/ksq_bydd_trd",
    "KOSDAQ stock daily trading",
    "코스닥(KOSDAQ) 주식 일별매매정보",
    "stock",
  ),
  ep(
    "/svc/apis/sto/knx_bydd_trd",
    "KONEX stock daily trading",
    "코넥스(KONEX) 주식 일별매매정보",
    "stock",
  ),
  ep(
    "/svc/apis/sto/sw_bydd_trd",
    "Subscription warrant daily trading",
    "신주인수권증권 일별매매정보",
    "stock",
  ),
  ep(
    "/svc/apis/sto/sr_bydd_trd",
    "Subscription right daily trading",
    "신주인수권증서 일별매매정보",
    "stock",
  ),
  ep(
    "/svc/apis/sto/stk_isu_base_info",
    "KOSPI stock base info",
    "유가증권 종목 기본정보",
    "stock",
  ),
  ep(
    "/svc/apis/sto/ksq_isu_base_info",
    "KOSDAQ stock base info",
    "코스닥 종목 기본정보",
    "stock",
  ),
  ep(
    "/svc/apis/sto/knx_isu_base_info",
    "KONEX stock base info",
    "코넥스 종목 기본정보",
    "stock",
  ),

  // ETP
  ep(
    "/svc/apis/etp/etf_bydd_trd",
    "ETF daily trading",
    "ETF 일별매매정보",
    "etp",
  ),
  ep(
    "/svc/apis/etp/etn_bydd_trd",
    "ETN daily trading",
    "ETN 일별매매정보",
    "etp",
  ),
  ep(
    "/svc/apis/etp/elw_bydd_trd",
    "ELW daily trading",
    "ELW 일별매매정보",
    "etp",
  ),

  // Bond (bon)
  ep(
    "/svc/apis/bon/kts_bydd_trd",
    "KTS government bond daily trading",
    "국채전문유통시장 일별매매정보",
    "bond",
  ),
  ep(
    "/svc/apis/bon/bnd_bydd_trd",
    "General bond daily trading",
    "일반채권시장 일별매매정보",
    "bond",
  ),
  ep(
    "/svc/apis/bon/smb_bydd_trd",
    "Small bond daily trading",
    "소액채권시장 일별매매정보",
    "bond",
  ),

  // Derivatives (drv)
  ep(
    "/svc/apis/drv/fut_bydd_trd",
    "Futures daily trading",
    "선물 일별매매정보",
    "derivative",
  ),
  ep(
    "/svc/apis/drv/eqsfu_stk_bydd_trd",
    "KOSPI stock futures daily trading",
    "유가증권 주식선물 일별매매정보",
    "derivative",
  ),
  ep(
    "/svc/apis/drv/eqkfu_ksq_bydd_trd",
    "KOSDAQ stock futures daily trading",
    "코스닥 주식선물 일별매매정보",
    "derivative",
  ),
  ep(
    "/svc/apis/drv/opt_bydd_trd",
    "Options daily trading",
    "옵션 일별매매정보",
    "derivative",
  ),
  ep(
    "/svc/apis/drv/eqsop_bydd_trd",
    "KOSPI stock options daily trading",
    "유가증권 주식옵션 일별매매정보",
    "derivative",
  ),
  ep(
    "/svc/apis/drv/eqkop_bydd_trd",
    "KOSDAQ stock options daily trading",
    "코스닥 주식옵션 일별매매정보",
    "derivative",
  ),

  // Commodities (gen)
  ep(
    "/svc/apis/gen/oil_bydd_trd",
    "Oil market daily trading",
    "석유시장 일별매매정보",
    "commodity",
  ),
  ep(
    "/svc/apis/gen/gold_bydd_trd",
    "Gold market daily trading",
    "금시장 일별매매정보",
    "commodity",
  ),
  ep(
    "/svc/apis/gen/ets_bydd_trd",
    "Emission trading daily",
    "배출권시장 일별매매정보",
    "commodity",
  ),

  // ESG
  ep(
    "/svc/apis/esg/sri_bond_info",
    "SRI bond info",
    "사회책임투자채권 종목정보",
    "esg",
  ),
  ep("/svc/apis/esg/esg_etp_info", "ESG ETP info", "ESG 증권상품 정보", "esg"),
  ep("/svc/apis/esg/esg_index_info", "ESG index info", "ESG 지수 정보", "esg"),
];

export function getEndpointsByCategory(
  category: CategoryId,
): readonly EndpointDef[] {
  return ENDPOINTS.filter((e) => e.category === category);
}

export function getCategoryById(id: CategoryId): CategoryDef | undefined {
  return CATEGORIES.find((c) => c.id === id);
}
