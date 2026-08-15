/**
 * The post id inside a Discord link, e.g.
 * https://discord.com/channels/<guild>/<postId>[/<messageId>]. A bare id is
 * accepted as well, so admins can paste either form.
 */
export function parseDiscordPostId(input: string): string | undefined {
  const trimmed = input.trim();
  if (/^\d{17,20}$/.test(trimmed)) return trimmed;

  const match = trimmed.match(
    /^https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/channels\/(?:\d{17,20}|@me)\/(\d{17,20})/,
  );
  return match?.[1];
}
