import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api, apiClient } from './api';

describe('api pool methods (#804)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('listCampaignPools GETs the campaign-pools list for a campaign', async () => {
    const spy = vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { success: true, data: [] } });
    const result = await api.listCampaignPools('campaign-1');

    expect(spy).toHaveBeenCalledWith('/campaign-pools/campaign/campaign-1');
    expect(result).toEqual({ success: true, data: [] });
  });

  it('createPool POSTs the pool fields to /campaign-pools', async () => {
    const spy = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: { success: true, data: { id: 'pool-1' } } });
    await api.createPool({ campaign_id: 'campaign-1', title: 'Team Alpha', target_amount: 100 });

    expect(spy).toHaveBeenCalledWith('/campaign-pools', {
      campaign_id: 'campaign-1',
      title: 'Team Alpha',
      description: undefined,
      target_amount: 100,
      expires_at: undefined,
    });
  });

  it('joinPool POSTs share_amount and display_name to the join endpoint', async () => {
    const spy = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: { success: true } });
    await api.joinPool('pool-1', 25, 'Alice');

    expect(spy).toHaveBeenCalledWith('/campaign-pools/pool-1/join', {
      share_amount: 25,
      display_name: 'Alice',
    });
  });

  it('leavePool POSTs to the leave endpoint', async () => {
    const spy = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: { success: true } });
    await api.leavePool('pool-1');

    expect(spy).toHaveBeenCalledWith('/campaign-pools/pool-1/leave');
  });

  it('submitPool POSTs to the submit endpoint', async () => {
    const spy = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: { success: true } });
    await api.submitPool('pool-1');

    expect(spy).toHaveBeenCalledWith('/campaign-pools/pool-1/submit');
  });
});
