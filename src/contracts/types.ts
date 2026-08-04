export interface ContractField {
  readonly name: string;
  readonly type: string;
}

export interface OfficialEndpointSpec {
  readonly path: string;
  readonly officialName: string;
  readonly modifiedDate: string;
  readonly detailUrl: string;
  readonly requestFields: readonly ContractField[];
  readonly responseFields: readonly ContractField[];
}

export interface ChangedFieldType {
  readonly name: string;
  readonly maintainedType: string;
  readonly officialTypes: readonly string[];
}

export interface FieldDrift {
  readonly addedInOfficial: readonly string[];
  readonly missingFromOfficial: readonly string[];
  readonly changedTypes: readonly ChangedFieldType[];
}

export interface ObservedFieldDrift {
  readonly addedInObserved: readonly string[];
  readonly missingFromObserved: readonly string[];
  readonly changedTypes: readonly {
    readonly name: string;
    readonly maintainedType: string;
    readonly observedTypes: readonly string[];
  }[];
}

export interface EndpointSpecDrift {
  readonly path: string;
  readonly officialName: string;
  readonly detailUrl: string;
  readonly maintainedModifiedDate?: string;
  readonly officialModifiedDate: string;
  readonly modifiedDateChanged: boolean;
  readonly request: FieldDrift;
  readonly response: FieldDrift;
}

export interface OfficialRegistryDrift {
  readonly catalogUrl: string;
  readonly officialServiceCount: number;
  readonly maintainedServiceCount: number;
  readonly addedServices: readonly string[];
  readonly missingServices: readonly string[];
  readonly duplicateOfficialPaths: readonly string[];
  readonly endpoints: readonly EndpointSpecDrift[];
  readonly hasDrift: boolean;
}

export type ProbeStatus =
  | "passed"
  | "empty"
  | "http_error"
  | "krx_error"
  | "invalid_response"
  | "schema_drift"
  | "quota_rejected"
  | "request_failed";

export interface ProbeIssue {
  readonly code: string;
  readonly message: string;
}

export interface LiveProbeReport {
  readonly path: string;
  readonly date: string;
  readonly status: ProbeStatus;
  readonly httpStatus?: number;
  readonly krxErrorCode?: string;
  readonly quotaReserved: boolean;
  readonly rowCount: number;
  readonly response: ObservedFieldDrift;
  readonly issues: readonly ProbeIssue[];
}

export interface ContractPlan {
  readonly date: string;
  readonly registeredEndpoints: number;
  readonly credentialedProbeCalls: number;
  readonly maximumDailyKrxCalls: number;
  readonly expectedOfficialSpecRequests: number;
  readonly maximumOfficialSpecRequests: number;
  readonly probePaths: readonly string[];
  readonly exclusions: readonly { path: string; reason: string }[];
}

export interface ContractReport {
  readonly version: 1;
  readonly mode: "live";
  readonly generatedAt: string;
  readonly passed: boolean;
  readonly plan: ContractPlan;
  readonly official: OfficialRegistryDrift;
  readonly probes: readonly LiveProbeReport[];
  readonly summary: {
    readonly passedProbes: number;
    readonly failedProbes: number;
    readonly reservedKrxCalls: number;
  };
}
