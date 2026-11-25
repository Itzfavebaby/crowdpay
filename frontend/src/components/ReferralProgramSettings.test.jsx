import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import ReferralProgramSettings from './ReferralProgramSettings';
import { api } from '../services/api';

vi.mock('../services/api', () => ({
  api: {
    getReferralProgram: vi.fn(),
    enableReferralProgram: vi.fn(),
  },
}));

const existingProgram = { commission_percentage: '8', max_referrers: '30' };

async function renderDisabled() {
  api.getReferralProgram.mockRejectedValue(new Error('not found'));
  render(<ReferralProgramSettings campaignId="c-1" />);
  await waitFor(() => expect(api.getReferralProgram).toHaveBeenCalledWith('c-1'));
}

async function renderEnabled(program = existingProgram) {
  api.getReferralProgram.mockResolvedValue(program);
  render(<ReferralProgramSettings campaignId="c-1" />);
  await screen.findByLabelText(/Maximum referrers/i);
}

describe('ReferralProgramSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('enable/disable toggle', () => {
    it('starts disabled and hides the settings when no program exists', async () => {
      await renderDisabled();
      expect(screen.getByLabelText('Enable referrals')).not.toBeChecked();
      expect(screen.queryByLabelText(/Maximum referrers/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('starts enabled and loads values when a program exists', async () => {
      await renderEnabled();
      expect(screen.getByLabelText('Enable referrals')).toBeChecked();
      expect(screen.getByLabelText(/Maximum referrers/i)).toHaveValue(30);
      expect(screen.getByLabelText(/Commission: 8%/)).toHaveValue('8');
      expect(screen.getByRole('button', { name: 'Update referral program' })).toBeInTheDocument();
    });

    it('reveals the form with defaults when toggled on', async () => {
      await renderDisabled();
      fireEvent.click(screen.getByLabelText('Enable referrals'));
      expect(screen.getByLabelText(/Commission: 5%/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Maximum referrers/i)).toHaveValue(20);
      expect(screen.getByRole('button', { name: 'Enable referrals' })).toBeInTheDocument();
    });

    it('hides the form again when toggled off', async () => {
      await renderEnabled();
      fireEvent.click(screen.getByLabelText('Enable referrals'));
      expect(screen.queryByLabelText(/Maximum referrers/i)).not.toBeInTheDocument();
    });

    it('does not fetch without a campaign id', () => {
      render(<ReferralProgramSettings />);
      expect(api.getReferralProgram).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Enable referrals')).not.toBeChecked();
    });
  });

  describe('commission percentage and max referrer bounds', () => {
    it('constrains the commission slider to 1-20%', async () => {
      await renderEnabled();
      const slider = screen.getByLabelText(/Commission:/);
      expect(slider).toHaveAttribute('type', 'range');
      expect(slider).toHaveAttribute('min', '1');
      expect(slider).toHaveAttribute('max', '20');
      expect(slider).toHaveAttribute('step', '1');
    });

    it('constrains maximum referrers to 1-100', async () => {
      await renderEnabled();
      const input = screen.getByLabelText(/Maximum referrers/i);
      expect(input).toHaveAttribute('type', 'number');
      expect(input).toHaveAttribute('min', '1');
      expect(input).toHaveAttribute('max', '100');
    });

    it('updates the commission label as the slider moves', async () => {
      await renderEnabled();
      fireEvent.change(screen.getByLabelText(/Commission:/), { target: { value: '12' } });
      expect(screen.getByText('Commission: 12%')).toBeInTheDocument();
    });

    it('sends numeric commission and max referrers on save', async () => {
      api.enableReferralProgram.mockResolvedValue({ commission_percentage: 12, max_referrers: 45 });
      await renderEnabled();
      fireEvent.change(screen.getByLabelText(/Commission:/), { target: { value: '12' } });
      fireEvent.change(screen.getByLabelText(/Maximum referrers/i), { target: { value: '45' } });
      fireEvent.click(screen.getByRole('button', { name: 'Update referral program' }));

      await waitFor(() =>
        expect(api.enableReferralProgram).toHaveBeenCalledWith('c-1', {
          commissionPercentage: 12,
          maxReferrers: 45,
        })
      );
      const payload = api.enableReferralProgram.mock.calls[0][1];
      expect(typeof payload.commissionPercentage).toBe('number');
      expect(typeof payload.maxReferrers).toBe('number');
    });

    it('saves the default commission and max referrers for a new program', async () => {
      api.enableReferralProgram.mockResolvedValue({ commission_percentage: 5, max_referrers: 20 });
      await renderDisabled();
      fireEvent.click(screen.getByLabelText('Enable referrals'));
      fireEvent.click(screen.getByRole('button', { name: 'Enable referrals' }));
      await waitFor(() =>
        expect(api.enableReferralProgram).toHaveBeenCalledWith('c-1', {
          commissionPercentage: 5,
          maxReferrers: 20,
        })
      );
    });

    it('does not clamp out-of-range max referrers client-side (server validates)', async () => {
      api.enableReferralProgram.mockResolvedValue({ commission_percentage: 5, max_referrers: 500 });
      await renderEnabled();
      fireEvent.change(screen.getByLabelText(/Maximum referrers/i), { target: { value: '500' } });
      fireEvent.click(screen.getByRole('button', { name: 'Update referral program' }));
      await waitFor(() =>
        expect(api.enableReferralProgram).toHaveBeenCalledWith(
          'c-1',
          expect.objectContaining({ maxReferrers: 500 })
        )
      );
    });
  });

  describe('save', () => {
    it('shows a success message and switches the button label after saving', async () => {
      api.enableReferralProgram.mockResolvedValue({ commission_percentage: 5, max_referrers: 20 });
      await renderDisabled();
      fireEvent.click(screen.getByLabelText('Enable referrals'));
      fireEvent.click(screen.getByRole('button', { name: 'Enable referrals' }));

      expect(await screen.findByText('Referral program saved.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Update referral program' })).toBeInTheDocument();
    });

    it('disables the button and shows progress while saving', async () => {
      let resolve;
      api.enableReferralProgram.mockReturnValue(new Promise((r) => (resolve = r)));
      await renderEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Update referral program' }));

      const busy = await screen.findByRole('button', { name: /Saving/ });
      expect(busy).toBeDisabled();

      resolve(existingProgram);
      await screen.findByText('Referral program saved.');
      expect(screen.getByRole('button', { name: 'Update referral program' })).toBeEnabled();
    });
  });

  describe('save error handling', () => {
    it('shows the error message from a failed save and no success message', async () => {
      api.enableReferralProgram.mockRejectedValue(new Error('Commission too high'));
      await renderEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Update referral program' }));

      expect(await screen.findByText('Commission too high')).toBeInTheDocument();
      expect(screen.queryByText('Referral program saved.')).not.toBeInTheDocument();
    });

    it('falls back to a generic message when the error has no message', async () => {
      api.enableReferralProgram.mockRejectedValue({});
      await renderEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Update referral program' }));
      expect(await screen.findByText('Could not save the referral program')).toBeInTheDocument();
    });

    it('re-enables the button after a failure so the user can retry', async () => {
      api.enableReferralProgram.mockRejectedValueOnce(new Error('boom'));
      api.enableReferralProgram.mockResolvedValueOnce(existingProgram);
      await renderEnabled();
      const button = screen.getByRole('button', { name: 'Update referral program' });
      fireEvent.click(button);
      await screen.findByText('boom');
      expect(button).toBeEnabled();

      fireEvent.click(button);
      expect(await screen.findByText('Referral program saved.')).toBeInTheDocument();
      expect(screen.queryByText('boom')).not.toBeInTheDocument();
    });
  });
});
