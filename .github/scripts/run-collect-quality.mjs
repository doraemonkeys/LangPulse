#!/usr/bin/env node

import { runCollectorUntilPublication } from "./collect-quality-publication.mjs";

runCollectorUntilPublication(process.env).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
