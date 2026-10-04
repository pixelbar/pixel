/**
 * Loaded with `node --import` before the app so Sentry can instrument
 * everything that follows. Does nothing when SENTRY_DSN is unset.
 */
import * as Sentry from "@sentry/node";
import { loadSentryConfig } from "./config.ts";
import { sentryOptions } from "./observability/sentry-options.ts";

const sentry = loadSentryConfig();

if (sentry) Sentry.init(sentryOptions(sentry));
