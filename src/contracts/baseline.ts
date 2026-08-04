/**
 * Last reviewed dates from each official KRX service specification.
 * A date change is drift until the linked specification and maintained
 * request/response contracts have been reviewed together.
 */
export const OFFICIAL_MODIFIED_DATE_BASELINE: Readonly<Record<string, string>> =
  {
    "/svc/apis/idx/krx_dd_trd": "2026/01/16",
    "/svc/apis/idx/kospi_dd_trd": "2026/01/16",
    "/svc/apis/idx/kosdaq_dd_trd": "2026/01/16",
    "/svc/apis/idx/bon_dd_trd": "2026/01/16",
    "/svc/apis/idx/drvprod_dd_trd": "2026/01/16",
    "/svc/apis/sto/stk_bydd_trd": "2026/01/16",
    "/svc/apis/sto/ksq_bydd_trd": "2026/01/16",
    "/svc/apis/sto/knx_bydd_trd": "2026/01/16",
    "/svc/apis/sto/sw_bydd_trd": "2026/01/16",
    "/svc/apis/sto/sr_bydd_trd": "2026/01/16",
    "/svc/apis/sto/stk_isu_base_info": "2026/01/16",
    "/svc/apis/sto/ksq_isu_base_info": "2026/01/16",
    "/svc/apis/sto/knx_isu_base_info": "2026/01/16",
    "/svc/apis/etp/etf_bydd_trd": "2026/01/16",
    "/svc/apis/etp/etn_bydd_trd": "2026/01/16",
    "/svc/apis/etp/elw_bydd_trd": "2026/01/16",
    "/svc/apis/bon/kts_bydd_trd": "2026/01/16",
    "/svc/apis/bon/bnd_bydd_trd": "2026/01/16",
    "/svc/apis/bon/smb_bydd_trd": "2026/01/16",
    "/svc/apis/drv/fut_bydd_trd": "2026/01/16",
    "/svc/apis/drv/eqsfu_stk_bydd_trd": "2026/01/16",
    "/svc/apis/drv/eqkfu_ksq_bydd_trd": "2026/01/16",
    "/svc/apis/drv/opt_bydd_trd": "2026/07/16",
    "/svc/apis/drv/eqsop_bydd_trd": "2026/07/16",
    "/svc/apis/drv/eqkop_bydd_trd": "2026/01/16",
    "/svc/apis/gen/oil_bydd_trd": "2026/01/16",
    "/svc/apis/gen/gold_bydd_trd": "2026/01/16",
    "/svc/apis/gen/ets_bydd_trd": "2026/01/16",
    "/svc/apis/esg/esg_etp_info": "2026/03/30",
    "/svc/apis/esg/sri_bond_info": "2026/01/16",
    "/svc/apis/esg/esg_index_info": "2026/03/30",
  };

export const CONTRACT_PROBE_EXCLUSIONS: readonly {
  readonly path: string;
  readonly reason: string;
}[] = [];
