"""Persist immutable source-bound owner reviews. Approval never imports the account."""
import hashlib
import uuid
from .paper_import_review import review_snapshot
from .paper_recovery_evidence import compare_recovery_source
from .paper_ledger import _json
from .paper_ledger_model import PaperLedgerError, digest


class PaperRecoveryReview:
    def __init__(self, ledger, source):
        self.ledger, self.source = ledger, source

    @staticmethod
    def require_owner(actor):
        if actor.role != 'owner' or not actor.actor_id:
            raise PaperLedgerError('paper_actor_denied')

    def evidence(self, actor):
        self.require_owner(actor)
        raw = self.source.read_bytes()
        review = review_snapshot(raw)
        if review.get('openingProposal', {}).get('status') != 'needs_owner_review':
            raise PaperLedgerError('recovery_proposal_unavailable')
        cutoff = review['recoverySource']['restored_at']
        with self.ledger._connect() as conn:
            rows = conn.execute('SELECT public.paper_recovery_source(%s,%s) AS rows', (actor.owner_id, cutoff)).fetchone()['rows']
        source = {'sourceHash':review['sourceHash'], 'ownerId':actor.owner_id, 'cutoff':cutoff, 'rows':rows}
        comparison = compare_recovery_source(review, source, actor.owner_id)
        if comparison['status'] != 'matched':
            raise PaperLedgerError('recovery_source_incomplete')
        if self.source.read_bytes() != raw:
            raise PaperLedgerError('import_source_changed')
        return {'review':review, 'source':source, 'comparison':comparison}

    def prepare(self, actor):
        evidence = self.evidence(actor)
        review_hash = digest(evidence)
        review_id = str(uuid.uuid5(uuid.UUID(actor.owner_id), 'paper-review:'+review_hash))
        with self.ledger._connect() as conn:
            conn.execute('''INSERT INTO paper_recovery_reviews(id,owner_id,source_hash,review_hash,evidence)
                VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING''',
                (review_id,actor.owner_id,evidence['review']['sourceHash'],review_hash,_json(evidence)))
        return {'reviewId':review_id,'reviewHash':review_hash,'evidence':evidence,'accountChanged':False}

    def decide(self, actor, review_id, command_id, review_hash, decision, acknowledgements):
        self.require_owner(actor)
        if not isinstance(command_id,str) or not command_id.strip() or len(command_id)>200 or decision not in {'approved','rejected'}:
            raise PaperLedgerError('invalid_review_decision')
        if decision == 'approved' and (not isinstance(acknowledgements,dict) or
            any(acknowledgements.get(key) is not True for key in ('historicalCashIncomplete','historicalPnlIncomplete','preserveCurrentBalances'))):
            raise PaperLedgerError('recovery_acknowledgements_required')
        payload_hash = digest({'reviewId':review_id,'reviewHash':review_hash,'decision':decision,'acknowledgements':acknowledgements})
        with self.ledger._connect() as conn:
            conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', ('paper-review:'+actor.owner_id,))
            prior = conn.execute('SELECT * FROM paper_recovery_decisions WHERE owner_id=%s AND command_id=%s',(actor.owner_id,command_id)).fetchone()
            if prior:
                if prior['payload_hash'] != payload_hash:
                    raise PaperLedgerError('command_payload_conflict')
                return {'reviewId':str(prior['review_id']),'decision':prior['decision'],'replayed':True,'accountChanged':False}
            # Owner-scoped advisory lock serializes decisions; review rows are append-only.
            review = conn.execute('SELECT * FROM paper_recovery_reviews WHERE id=%s AND owner_id=%s',(review_id,actor.owner_id)).fetchone()
            if not review or review['review_hash'] != review_hash:
                raise PaperLedgerError('recovery_review_not_found_or_changed')
            if conn.execute('SELECT 1 FROM paper_recovery_decisions WHERE review_id=%s',(review_id,)).fetchone():
                raise PaperLedgerError('recovery_review_already_decided')
            if decision == 'approved' and hashlib.sha256(self.source.read_bytes()).hexdigest() != review['source_hash']:
                raise PaperLedgerError('import_source_changed')
            conn.execute('''INSERT INTO paper_recovery_decisions(review_id,owner_id,command_id,payload_hash,decision,actor,acknowledgements)
                VALUES (%s,%s,%s,%s,%s,%s,%s)''',(review_id,actor.owner_id,command_id,payload_hash,decision,actor.actor_id,_json(acknowledgements)))
        return {'reviewId':review_id,'decision':decision,'replayed':False,'accountChanged':False}

    def read(self, actor, review_id):
        self.require_owner(actor)
        with self.ledger._connect() as conn:
            row = conn.execute('''SELECT r.*,d.decision,d.command_id,d.actor,d.created_at AS decided_at
                FROM paper_recovery_reviews r LEFT JOIN paper_recovery_decisions d ON d.review_id=r.id
                WHERE r.id=%s AND r.owner_id=%s''',(review_id,actor.owner_id)).fetchone()
        if not row:
            raise PaperLedgerError('recovery_review_not_found_or_changed')
        return {'reviewId':str(row['id']),'reviewHash':row['review_hash'],'evidence':row['evidence'],
                'decision':row['decision'] or 'pending','commandId':row['command_id'],
                'decidedAt':row['decided_at'].isoformat() if row['decided_at'] else None,'accountChanged':False}
