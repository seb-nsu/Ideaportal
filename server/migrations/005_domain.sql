-- Release 2 domain features (epic J and O) on top of 004: reminder markers for the
-- mentor timebox (R2-01). No new tables; all Release 2 tables are created in 004 with RLS.

ALTER TABLE ideas ADD COLUMN timebox_reminded_at timestamptz;
ALTER TABLE ideas ADD COLUMN timebox_exceeded_at timestamptz;

CREATE INDEX ideas_mentor ON ideas (mentor_id) WHERE mentor_id IS NOT NULL;
CREATE INDEX decisions_meeting ON decisions (meeting_id) WHERE meeting_id IS NOT NULL;
CREATE INDEX scorecards_idea_context ON scorecards (idea_id, context);
CREATE INDEX experiments_idea ON experiments (idea_id);
