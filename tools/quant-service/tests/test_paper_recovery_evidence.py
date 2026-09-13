import unittest
from app.paper_recovery_evidence import compare_recovery_source
from app.paper_ledger_model import PaperLedgerError


class RecoveryEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.review={'sourceHash':'source', 'reviewHash':'review', 'recoverySource':{'restored_at':'2026-08-09T07:33:00+08:00'},
                     'openingProposal':{'status':'needs_owner_review','baseline':{'lots':[{'lotId':'lot','code':'159278.SZ','quantity':100,'costPrice':'0.911','tradeDate':'2026-08-07'}]}}}
        self.source={'ownerId':'owner','sourceHash':'source','cutoff':'2026-08-09T07:33:00+08:00','rows':[
            {'id':'snapshot','workshop_id':'work','code':'159278','trade_date':'2026-08-07','created_at':'2026-08-07T12:32:01+00:00',
             'position':{'quantity':100,'cost_price':0.911}}]}

    def test_code_normalization_preserves_precision_and_no_approval(self):
        result=compare_recovery_source(self.review,self.source,'owner')
        self.assertEqual(result['status'],'matched')
        self.assertEqual(result['matched'][0]['snapshotId'],'snapshot')
        self.assertFalse(result['importAllowed'])
        self.assertFalse(result['cashAndRealizedPnlSourceVerified'])

    def test_wrong_owner_source_and_latest_mismatch(self):
        with self.assertRaises(PaperLedgerError):
            compare_recovery_source(self.review,self.source,'another')
        self.source['rows'][0]['position']['cost_price']=0.912
        self.assertEqual(compare_recovery_source(self.review,self.source,'owner')['status'],'incomplete')
        self.source['sourceHash']='changed'
        with self.assertRaises(PaperLedgerError):
            compare_recovery_source(self.review,self.source,'owner')
