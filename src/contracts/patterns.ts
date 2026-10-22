/** Validation patterns shared by the CLI and the daemon, so the two can never disagree. */
export const CONTEXT_ID_PATTERN = /^ctx_[0-9a-f]{4,}$/;

/** Profile names become directory names under ATC_HOME/profiles: no separators, no dots. */
export const PROFILE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
