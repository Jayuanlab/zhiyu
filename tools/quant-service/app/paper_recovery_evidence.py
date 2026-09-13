"""Match declared recovery lots to a read-only, owner-scoped source export."""
from .paper_ledger_model import number, quantity, timestamp, digest, PaperLedgerError


def compare_recovery_source(review: dict, source: dict, owner_id: str) -> dict:
    if source.get('ownerId') != owner_id or source.get('sourceHash') != review.get('sourceHash'):
        raise PaperLedgerError('recovery_source_owner_or_hash_mismatch')
    proposal = review.get('openingProposal', {})
    if proposal.get('status') != 'needs_owner_review':
        raise PaperLedgerError('recovery_proposal_unavailable')
    cutoff = timestamp(source['cutoff'])
    if cutoff != timestamp(review['recoverySource']['restored_at']):
        raise PaperLedgerError('recovery_cutoff_mismatch')
    matched, missing = [], []
    for lot in proposal['baseline']['lots']:
        rows = [row for row in source['rows'] if row['code'] in {lot['code'], lot['code'].split('.')[0]}
                and timestamp(row['created_at']) <= cutoff]
        rows.sort(key=lambda row: timestamp(row['created_at']), reverse=True)
        if not rows:
            missing.append({'lotId':lot['lotId'], 'reasonCode':'source_snapshot_missing'})
            continue
        latest = rows[0]
        position = latest.get('position') or {}
        if (latest.get('trade_date') != lot.get('tradeDate')
                or quantity(position.get('quantity')) != quantity(lot['quantity'])
                or number(position.get('cost_price'), 3) != number(lot['costPrice'], 3)):
            missing.append({'lotId':lot['lotId'], 'reasonCode':'latest_source_position_mismatch'})
            continue
        matched.append({'lotId':lot['lotId'], 'snapshotId':latest['id'], 'workshopId':latest['workshop_id'],
                        'sourceEventId':latest.get('source_event_id'), 'createdAt':latest['created_at'],
                        'positionHash':digest(position)})
    return {'status':'matched' if not missing else 'incomplete', 'sourceHash':review['sourceHash'],
            'reviewHash':review['reviewHash'], 'sourceExportHash':digest(source), 'ownerId':owner_id,
            'matched':matched, 'missing':missing, 'ownerApproved':False,
            'cashAndRealizedPnlSourceVerified':False, 'importAllowed':False}
