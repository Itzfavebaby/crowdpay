import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import PoolManager from './PoolManager';
import { api } from '../services/api';

const toast = vi.fn();

vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));
vi.mock('../context/ToastContext', () => ({
  useToast: vi.fn(),
}));
vi.mock('../services/api', () => ({
  api: {
    listCampaignPools: vi.fn(),
    createPool: vi.fn(),
    joinPool: vi.fn(),
    leavePool: vi.fn(),
    submitPool: vi.fn(),
  },
}));

import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

const CAMPAIGN_ID = 'campaign-1';

function openPool(overrides = {}) {
  return {
    id: 'pool-1',
    campaign_id: CAMPAIGN_ID,
    leader_id: 'leader-1',
    title: 'Team Alpha',
    description: null,
    target_amount: '100.0000000',
    raised_amount: '0.0000000',
    status: 'open',
    member_count: 1,
    ...overrides,
  };
}

describe('PoolManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useToast.mockReturnValue({ toast });
    api.listCampaignPools.mockResolvedValue({ data: [] });
  });

  it('prompts sign-in when there is no authenticated user', async () => {
    useAuth.mockReturnValue({ user: null });
    render(<PoolManager campaignId={CAMPAIGN_ID} campaignTitle="Test Campaign" />);

    expect(await screen.findByText(/Sign in to create or join a contribution pool/)).toBeInTheDocument();
  });

  it('lists pools returned by the API for a logged-in user', async () => {
    useAuth.mockReturnValue({ user: { id: 'member-1' } });
    api.listCampaignPools.mockResolvedValue({ data: [openPool()] });

    render(<PoolManager campaignId={CAMPAIGN_ID} campaignTitle="Test Campaign" />);

    expect(await screen.findByText('Team Alpha')).toBeInTheDocument();
    expect(api.listCampaignPools).toHaveBeenCalledWith(CAMPAIGN_ID);
  });

  it('creates a pool and refreshes the list', async () => {
    useAuth.mockReturnValue({ user: { id: 'leader-1' } });
    api.listCampaignPools.mockResolvedValue({ data: [] });
    api.createPool.mockResolvedValue({ data: openPool() });

    render(<PoolManager campaignId={CAMPAIGN_ID} campaignTitle="Test Campaign" />);

    fireEvent.click(await screen.findByRole('button', { name: '+ New Pool' }));
    fireEvent.change(screen.getByPlaceholderText('Pool name (e.g. Team Alpha)'), {
      target: { value: 'Team Alpha' },
    });
    fireEvent.change(screen.getByPlaceholderText('100.00'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Pool' }));

    await waitFor(() =>
      expect(api.createPool).toHaveBeenCalledWith({
        campaign_id: CAMPAIGN_ID,
        title: 'Team Alpha',
        description: undefined,
        target_amount: 100,
      })
    );
    expect(toast).toHaveBeenCalledWith('Pool created! Share the link with your group.', 'success');
  });

  it('lets a non-leader member join a pool with a share amount', async () => {
    useAuth.mockReturnValue({ user: { id: 'member-2' } });
    api.listCampaignPools.mockResolvedValue({ data: [openPool()] });
    api.joinPool.mockResolvedValue({ data: {} });

    render(<PoolManager campaignId={CAMPAIGN_ID} campaignTitle="Test Campaign" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Join Pool' }));
    fireEvent.change(screen.getByPlaceholderText('10.00'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(api.joinPool).toHaveBeenCalledWith('pool-1', 25, undefined));
    expect(toast).toHaveBeenCalledWith('You have joined the pool!', 'success');
  });

  it('shows an error toast and does not refresh optimistically when join fails', async () => {
    useAuth.mockReturnValue({ user: { id: 'member-2' } });
    api.listCampaignPools.mockResolvedValue({ data: [openPool()] });
    api.joinPool.mockRejectedValue(new Error('Share amount exceeds remaining pool target'));

    render(<PoolManager campaignId={CAMPAIGN_ID} campaignTitle="Test Campaign" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Join Pool' }));
    fireEvent.change(screen.getByPlaceholderText('10.00'), { target: { value: '999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Share amount exceeds remaining pool target', 'error')
    );
  });

  it('lets the leader submit an open pool', async () => {
    useAuth.mockReturnValue({ user: { id: 'leader-1' } });
    api.listCampaignPools.mockResolvedValue({ data: [openPool()] });
    api.submitPool.mockResolvedValue({ data: { pool_id: 'pool-1', tx_hash: 'txhash' } });

    render(<PoolManager campaignId={CAMPAIGN_ID} campaignTitle="Test Campaign" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Submit Pool' }));

    await waitFor(() => expect(api.submitPool).toHaveBeenCalledWith('pool-1'));
  });

  it('does not show a submit button to a non-leader member', async () => {
    useAuth.mockReturnValue({ user: { id: 'member-2' } });
    api.listCampaignPools.mockResolvedValue({ data: [openPool()] });

    render(<PoolManager campaignId={CAMPAIGN_ID} campaignTitle="Test Campaign" />);

    await screen.findByText('Team Alpha');
    expect(screen.queryByRole('button', { name: 'Submit Pool' })).not.toBeInTheDocument();
  });

  it('lets the leader cancel (leave) an open pool', async () => {
    useAuth.mockReturnValue({ user: { id: 'leader-1' } });
    api.listCampaignPools.mockResolvedValue({ data: [openPool()] });
    api.leavePool.mockResolvedValue({});

    render(<PoolManager campaignId={CAMPAIGN_ID} campaignTitle="Test Campaign" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel Pool' }));

    await waitFor(() => expect(api.leavePool).toHaveBeenCalledWith('pool-1'));
  });
});
