import type { EndpointDef } from "../client/endpoints.js";
import { KRX_SERVICE_CATALOG_URL } from "./official-spec.js";
import type {
  ContractField,
  FieldDrift,
  OfficialEndpointSpec,
  OfficialRegistryDrift,
} from "./types.js";

function compareFields(
  maintained: readonly ContractField[],
  official: readonly ContractField[],
): FieldDrift {
  const maintainedByName = new Map(
    maintained.map((field) => [field.name, field.type]),
  );
  const officialByName = new Map<string, Set<string>>();
  for (const field of official) {
    const types = officialByName.get(field.name) ?? new Set<string>();
    types.add(field.type);
    officialByName.set(field.name, types);
  }

  return {
    addedInOfficial: [...officialByName.keys()]
      .filter((name) => !maintainedByName.has(name))
      .sort(),
    missingFromOfficial: [...maintainedByName.keys()]
      .filter((name) => !officialByName.has(name))
      .sort(),
    changedTypes: [...maintainedByName.entries()]
      .filter(([name, type]) => {
        const officialTypes = officialByName.get(name);
        return officialTypes && !officialTypes.has(type);
      })
      .map(([name, maintainedType]) => ({
        name,
        maintainedType,
        officialTypes: [...(officialByName.get(name) ?? [])].sort(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function hasFieldDrift(drift: FieldDrift): boolean {
  return (
    drift.addedInOfficial.length > 0 ||
    drift.missingFromOfficial.length > 0 ||
    drift.changedTypes.length > 0
  );
}

export function compareOfficialRegistry(
  endpoints: readonly EndpointDef[],
  officialSpecs: readonly OfficialEndpointSpec[],
  modifiedDateBaseline: Readonly<Record<string, string>>,
): OfficialRegistryDrift {
  const maintainedPaths = new Set(endpoints.map(({ path }) => path));
  const counts = new Map<string, number>();
  for (const spec of officialSpecs) {
    counts.set(spec.path, (counts.get(spec.path) ?? 0) + 1);
  }
  const officialByPath = new Map(
    officialSpecs.map((spec) => [spec.path, spec]),
  );

  const addedServices = [...officialByPath.keys()]
    .filter((path) => !maintainedPaths.has(path))
    .sort();
  const missingServices = [...maintainedPaths]
    .filter((path) => !officialByPath.has(path))
    .sort();
  const duplicateOfficialPaths = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([path]) => path)
    .sort();

  const endpointDrift = endpoints.flatMap((endpoint) => {
    const official = officialByPath.get(endpoint.path);
    if (!official) return [];
    const request = compareFields(
      endpoint.requestFields,
      official.requestFields,
    );
    const response = compareFields(
      endpoint.responseFields.map(({ name }) => ({ name, type: "string" })),
      official.responseFields,
    );
    const maintainedModifiedDate = modifiedDateBaseline[endpoint.path];
    return [
      {
        path: endpoint.path,
        officialName: official.officialName,
        detailUrl: official.detailUrl,
        ...(maintainedModifiedDate ? { maintainedModifiedDate } : {}),
        officialModifiedDate: official.modifiedDate,
        modifiedDateChanged:
          maintainedModifiedDate === undefined ||
          maintainedModifiedDate !== official.modifiedDate,
        request,
        response,
      },
    ];
  });
  const hasEndpointDrift = endpointDrift.some(
    (entry) =>
      entry.modifiedDateChanged ||
      hasFieldDrift(entry.request) ||
      hasFieldDrift(entry.response),
  );

  return {
    catalogUrl: KRX_SERVICE_CATALOG_URL,
    officialServiceCount: officialSpecs.length,
    maintainedServiceCount: endpoints.length,
    addedServices,
    missingServices,
    duplicateOfficialPaths,
    endpoints: endpointDrift,
    hasDrift:
      addedServices.length > 0 ||
      missingServices.length > 0 ||
      duplicateOfficialPaths.length > 0 ||
      hasEndpointDrift,
  };
}
