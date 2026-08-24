import { binding } from "./binding.js";
import { createKrxClientClass } from "./client-factory.js";

export { KrxError } from "./errors.js";

export const KrxClient = createKrxClientClass(binding);
