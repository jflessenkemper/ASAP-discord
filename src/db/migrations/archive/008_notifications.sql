-- 008: Notifications — in-app notifications for job updates, assignments, etc.
-- Currently no way to notify users of events asynchronously

DO $$ BEGIN
  CREATE TYPE notification_type AS ENUM (
    'job_created', 'job_assigned', 'job_started', 'job_completed', 'job_cancelled',
    'review_received', 'system'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  user_type user_type NOT NULL,
  type notification_type NOT NULL,
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  data JSONB DEFAULT '{}',
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, user_type);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, user_type, read) WHERE read = FALSE;
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
