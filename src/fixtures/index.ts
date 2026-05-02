import writeSkewDoctors from "../../fixtures/write_skew_doctors.json";
import serialStockDecrement from "../../fixtures/serial_stock_decrement.json";
import staleReadStrict from "../../fixtures/stale_read_strict.json";
import abortedWriteIgnored from "../../fixtures/aborted_write_ignored.json";
import type { History } from "../core/types";

export interface FixtureEntry {
  slug: string;
  title: string;
  history: History;
}

export const fixtureCatalog: FixtureEntry[] = [
  {
    slug: "write_skew_doctors",
    title: "Write skew",
    history: writeSkewDoctors as History,
  },
  {
    slug: "stale_read_strict",
    title: "Strict stale read",
    history: staleReadStrict as History,
  },
  {
    slug: "serial_stock_decrement",
    title: "Serializable stock",
    history: serialStockDecrement as History,
  },
  {
    slug: "aborted_write_ignored",
    title: "Aborted write ignored",
    history: abortedWriteIgnored as History,
  },
];
