-- Narrow capability for the paper role: validate and lock a signed Work lease,
-- without granting access to unrelated Work or user data.
CREATE FUNCTION public.paper_assert_execution(
  owner_id uuid, work_id uuid, execution_id uuid, worker text, fence integer, policy_hash text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  work_row public.workshops%ROWTYPE;
  lease_row public.workshop_execution_leases%ROWTYPE;
  run_status text;
BEGIN
  SELECT * INTO work_row FROM public.workshops WHERE id=work_id AND user_id=owner_id FOR UPDATE;
  IF NOT FOUND OR work_row.model_config->>'role' IS DISTINCT FROM 'paper_trader'
    OR md5(jsonb_build_object('modelConfig',work_row.model_config,'boundaryPolicy',work_row.boundary_policy)::text) IS DISTINCT FROM policy_hash
  THEN RAISE EXCEPTION 'paper_execution_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO lease_row FROM public.workshop_execution_leases WHERE workshop_id=work_id FOR UPDATE;
  IF NOT FOUND OR lease_row.phase<>'running' OR lease_row.run_id IS DISTINCT FROM execution_id
    OR lease_row.worker_id IS DISTINCT FROM worker OR lease_row.token IS DISTINCT FROM fence
    OR lease_row.lease_until IS NULL OR lease_row.lease_until<=clock_timestamp()
  THEN RAISE EXCEPTION 'paper_execution_denied' USING ERRCODE='42501'; END IF;
  SELECT status INTO run_status FROM public.workshop_runs WHERE id=execution_id AND workshop_id=work_id FOR UPDATE;
  IF run_status IS DISTINCT FROM 'running'
  THEN RAISE EXCEPTION 'paper_execution_denied' USING ERRCODE='42501'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.paper_assert_execution(uuid,uuid,uuid,text,integer,text) FROM PUBLIC;
