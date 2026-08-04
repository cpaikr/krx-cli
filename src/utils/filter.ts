import { parseKrxNumber, isKrxNumericString } from "./krx-number.js";
import { UserInputError } from "../errors.js";

type FilterOperator = ">" | "<" | ">=" | "<=" | "==" | "!=";

interface FilterExpression {
  readonly field: string;
  readonly operator: FilterOperator;
  readonly value: string;
}

const OPERATOR_PATTERN = /^(\S+)\s+(>=|<=|==|!=|>|<)\s+(.+)$/;

export function parseFilterExpression(
  expression: string,
): FilterExpression | null {
  const trimmed = expression.trim().replace(/\s+/g, " ");
  const match = OPERATOR_PATTERN.exec(trimmed);

  if (!match || !match[1] || !match[2] || !match[3]) {
    return null;
  }

  return {
    field: match[1],
    operator: match[2] as FilterOperator,
    value: match[3].trim(),
  };
}

export function assertFilterExpression(expression: string): FilterExpression {
  const parsed = parseFilterExpression(expression);
  if (!parsed) {
    throw new UserInputError(
      'Invalid filter expression. Expected "FIELD <operator> VALUE".',
    );
  }
  return parsed;
}

function compareValues(
  fieldValue: string,
  operator: FilterOperator,
  filterValue: string,
): boolean {
  const isNumeric =
    isKrxNumericString(fieldValue) && isKrxNumericString(filterValue);

  if (isNumeric) {
    const a = parseKrxNumber(fieldValue);
    const b = parseKrxNumber(filterValue);

    switch (operator) {
      case ">":
        return a > b;
      case "<":
        return a < b;
      case ">=":
        return a >= b;
      case "<=":
        return a <= b;
      case "==":
        return a === b;
      case "!=":
        return a !== b;
    }
  }

  switch (operator) {
    case "==":
      return fieldValue === filterValue;
    case "!=":
      return fieldValue !== filterValue;
    case ">":
      return fieldValue > filterValue;
    case "<":
      return fieldValue < filterValue;
    case ">=":
      return fieldValue >= filterValue;
    case "<=":
      return fieldValue <= filterValue;
    default: {
      const _exhaustive: never = operator;
      void _exhaustive;
      return false;
    }
  }
}

export function filterData<T extends Record<string, unknown>>(
  data: readonly T[],
  expression: string,
): readonly T[] {
  const parsed = assertFilterExpression(expression);

  return data.filter((row) => {
    const fieldValue = row[parsed.field];
    if (fieldValue === undefined || fieldValue === null) {
      return false;
    }
    return compareValues(String(fieldValue), parsed.operator, parsed.value);
  });
}
