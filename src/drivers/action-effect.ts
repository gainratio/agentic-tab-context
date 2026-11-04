export interface LocationSnapshot {
  url: string;
  title: string;
}

/**
 * Compare before/after page locations. This is deliberately conservative:
 * same URL and title means "no visible change", not proof that nothing changed.
 */
export type ObservedEffect = "url_changed" | "title_changed" | "no_visible_change";

export function actionEffect(before: LocationSnapshot, after: LocationSnapshot): ObservedEffect {
  if (before.url !== after.url) return "url_changed";
  if (before.title !== after.title) return "title_changed";
  return "no_visible_change";
}
