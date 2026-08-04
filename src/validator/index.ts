import { z } from "zod/v4";
import { UserInputError } from "../errors.js";

const DATE_PATTERN = /^\d{8}$/;

export const dateSchema = z
  .string()
  .regex(DATE_PATTERN, "Date must be YYYYMMDD format (8 digits)")
  .refine(
    (val) => {
      const year = parseInt(val.slice(0, 4), 10);
      const month = parseInt(val.slice(4, 6), 10);
      const day = parseInt(val.slice(6, 8), 10);
      if (year < 2010 || year > 2100) return false;
      if (month < 1 || month > 12) return false;
      if (day < 1 || day > 31) return false;
      const date = new Date(year, month - 1, day);
      return (
        date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day
      );
    },
    { message: "Invalid date. Must be a valid date from 2010 onwards." },
  );

export const marketSchema = z.enum(["kospi", "kosdaq", "konex", "krx"]);

export type Market = z.infer<typeof marketSchema>;

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const PATH_TRAVERSAL_PATTERN = /\.\.[/\\]/;

export function validateNoInjection(input: string): string | null {
  if (CONTROL_CHAR_PATTERN.test(input)) {
    return "Input contains control characters";
  }
  if (PATH_TRAVERSAL_PATTERN.test(input)) {
    return "Input contains path traversal";
  }
  return null;
}

export function validateDate(value: string): string {
  const result = dateSchema.safeParse(value);
  if (!result.success) {
    throw new UserInputError(result.error.issues[0]?.message ?? "Invalid date");
  }
  return result.data;
}

export function validateMarket(value: string): Market {
  const result = marketSchema.safeParse(value.toLowerCase());
  if (!result.success) {
    throw new UserInputError(
      `Invalid market: ${value}. Must be one of: kospi, kosdaq, konex, krx`,
    );
  }
  return result.data;
}
