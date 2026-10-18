/**
 * Migration 004: an index for the cross-video Title changes list.
 *
 * video_changes_video (video_id, seen_at) serves one video's timeline, but the
 * Title changes page asks for every `title` row newest first. Counter rows
 * outnumber title rows by orders of magnitude, so without this index that
 * query scans the whole table and sorts it in a temp b-tree.
 */
export const titleChangesIndex = `
CREATE INDEX video_changes_field_seen ON video_changes (field, seen_at);
`;
