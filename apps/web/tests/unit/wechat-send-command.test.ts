import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {sendWechatDesktopMessage,getWechatDesktopSendStatus} from '@/lib/wechat-desktop/client';
describe('wechat durable send transport',()=>{
  const fetchMock=vi.fn();
  beforeEach(()=>{fetchMock.mockReset();vi.stubGlobal('fetch',fetchMock);});
  afterEach(()=>vi.unstubAllGlobals());
  it('does not automatically resend after a lost response',async()=>{
    fetchMock.mockRejectedValueOnce(new TypeError('lost response')).mockResolvedValueOnce(new Response(JSON.stringify({ok:true,sentAt:1}),{status:200}));
    const input={commandId:'stable-attempt',recipientName:'recipient',message:'message',confirmToken:'token'};
    await expect(sendWechatDesktopMessage(input)).rejects.toThrow('lost response');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for(const call of fetchMock.mock.calls)expect(JSON.parse(call[1].body)).toEqual(input);
  });
  it('queries unknown status without invoking the send endpoint',async()=>{
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ok:true,status:'unknown',result:null}),{status:200}));
    expect(await getWechatDesktopSendStatus('stable-attempt')).toEqual({ok:true,status:'unknown',result:null});
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/send-status$/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({commandId:'stable-attempt'});
  });
});
