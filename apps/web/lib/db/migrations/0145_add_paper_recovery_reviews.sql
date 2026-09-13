CREATE TABLE paper_recovery_reviews (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "User"(id),
  source_hash text NOT NULL,
  review_hash text NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, review_hash)
);
--> statement-breakpoint
CREATE TABLE paper_recovery_decisions (
  review_id uuid PRIMARY KEY REFERENCES paper_recovery_reviews(id),
  owner_id uuid NOT NULL REFERENCES "User"(id),
  command_id text NOT NULL,
  payload_hash text NOT NULL,
  decision text NOT NULL CHECK(decision IN ('approved','rejected')),
  actor text NOT NULL,
  acknowledgements jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,command_id)
);
--> statement-breakpoint
CREATE FUNCTION public.paper_recovery_source(owner_id uuid, cutoff timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',s.id,'workshop_id',s.workshop_id,
    'source_event_id',s.source_event_id,'code',s.code,'trade_date',s.trade_date,
    'created_at',s.created_at,'position',s.snapshot->'position') ORDER BY s.code,s.created_at DESC,s.id DESC),'[]'::jsonb)
  FROM public.quant_trend_state_snapshots s JOIN public.workshops w ON w.id=s.workshop_id
  WHERE w.user_id=owner_id AND s.created_at<=cutoff
    AND s.snapshot->'position' IS NOT NULL AND s.snapshot->'position'<>'null'::jsonb
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.paper_recovery_source(uuid,timestamptz) FROM PUBLIC;
