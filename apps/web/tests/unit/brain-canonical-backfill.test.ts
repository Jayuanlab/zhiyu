import {describe,expect,it} from 'vitest';
import {canonicalBackfillHash,planCanonicalBackfillRow} from '@/lib/brain/canonical-backfill-plan';
const row={id:'memory',userId:'owner',scopeType:'global',scopeId:null,ownerType:'chat',ownerId:'owner',memoryType:'boundary',subject:'Orders',content:'Never send real orders',status:'candidate',confidence:50,evidenceRefs:[],tags:[],metadata:{},canonicalKind:null,canonicalGroupId:null};
describe('canonical backfill preview',()=>{
  it('plans only missing index fields without promoting status or inventing time/evidence',()=>{
    const plan=planCanonicalBackfillRow(row);
    expect(plan).toMatchObject({status:'mappable',missingEvidence:true,evidenceReachability:'not_checked',changes:{canonicalKind:'boundary'}});
    expect(Object.keys(plan.changes??{}).sort()).toEqual(['canonicalGroupId','canonicalKind']);
    expect(row.status).toBe('candidate');expect(row.metadata).toEqual({});
  });
  it('preserves explicit canonical metadata and reports disagreement rather than choosing a winner',()=>{
    expect(planCanonicalBackfillRow({...row,metadata:{canonicalKind:'plan',canonicalGroupId:'existing'}})).toMatchObject({changes:{canonicalKind:'plan',canonicalGroupId:'existing'}});
    expect(planCanonicalBackfillRow({...row,canonicalKind:'boundary',metadata:{canonicalKind:'plan'}})).toMatchObject({status:'conflict',changes:null});
    expect(planCanonicalBackfillRow({...row,canonicalKind:'boundary',canonicalGroupId:'existing'})).toMatchObject({status:'unchanged',changes:{}});
  });
  it('rejects ambiguous input and fingerprints semantic content independent of object key order',()=>{
    expect(planCanonicalBackfillRow({...row,scopeType:'unknown'}).status).toBe('invalid');
    expect(planCanonicalBackfillRow({...row,scopeId:'unexpected'}).status).toBe('invalid');
    expect(planCanonicalBackfillRow({...row,memoryType:'new_kind'}).status).toBe('invalid');
    expect(planCanonicalBackfillRow({...row,evidenceRefs:'broken'}).status).toBe('invalid');
    expect(canonicalBackfillHash({a:1,b:2})).toBe(canonicalBackfillHash({b:2,a:1}));
    expect(canonicalBackfillHash(row)).not.toBe(canonicalBackfillHash({...row,content:'User corrected'}));
  });
});
