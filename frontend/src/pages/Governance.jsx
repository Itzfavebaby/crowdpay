import { useState, useEffect } from 'react';
import { getNetwork, signTransaction } from '@stellar/freighter-api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import Navbar from '../components/Navbar';

/**
 * Governance actions are always requested from the same endpoint regardless
 * of wallet type — the server resolves the caller's wallet and either signs
 * inline (custodial) or hands back { mode: 'prepare', unsigned_xdr,
 * prepare_token } for a Freighter wallet to sign in the browser (#802).
 * This helper completes the Freighter leg when needed and returns the final
 * response body either way.
 */
async function completeGovernanceAction(prepareResponse, submitSignedUrl, token) {
  if (prepareResponse.mode !== 'prepare') {
    return prepareResponse;
  }

  const network = await getNetwork();
  if (network?.error) throw new Error('Could not read Freighter network');

  const signed = await signTransaction(prepareResponse.unsigned_xdr, {
    networkPassphrase: network?.networkPassphrase,
  });
  if (signed?.error) throw new Error(signed.error?.message || 'Freighter signing failed');
  if (!signed?.signedTxXdr) throw new Error('Freighter did not return a signed transaction');

  const response = await fetch(submitSignedUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      prepare_token: prepareResponse.prepare_token,
      signed_xdr: signed.signedTxXdr,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to submit signed transaction');
  }

  return response.json();
}

export default function Governance() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const [feeInfo, setFeeInfo] = useState(null);
  const [proposals, setProposals] = useState([]);
  const [activeProposal, setActiveProposal] = useState(null);
  const [userTokenBalance, setUserTokenBalance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [voting, setVoting] = useState(false);
  
  const [newProposal, setNewProposal] = useState({
    new_fee_bps: '',
    new_creator_share_bps: '',
    rationale_text: '',
  });

  useEffect(() => {
    loadGovernanceData();
  }, []);

  const loadGovernanceData = async () => {
    try {
      setLoading(true);
      
      // Load fee info
      const feeResponse = await fetch('/api/governance/fee');
      const feeData = await feeResponse.json();
      setFeeInfo(feeData);

      // Load proposals
      const proposalsResponse = await fetch('/api/governance/proposals');
      const proposalsData = await proposalsResponse.json();
      setProposals(proposalsData.proposals || []);

      // Load active proposal
      if (user) {
        const balanceResponse = await fetch('/api/governance/user/token-balance', {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`,
          },
        });
        const balanceData = await balanceResponse.json();
        setUserTokenBalance(balanceData);
      }

      // Check for active proposal
      const active = proposalsData.proposals?.find(p => p.status === 'active');
      if (active) {
        const detailResponse = await fetch(`/api/governance/proposals/${active.id}`);
        const detailData = await detailResponse.json();
        setActiveProposal(detailData.proposal);
      }
    } catch (error) {
      console.error('Failed to load governance data:', error);
      showToast('Failed to load governance data', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateProposal = async (e) => {
    e.preventDefault();
    const token = localStorage.getItem('token');

    try {
      const response = await fetch('/api/governance/proposals', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(newProposal),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to create proposal');
      }

      await completeGovernanceAction(await response.json(), '/api/governance/proposals/submit-signed', token);

      showToast('Proposal created successfully', 'success');
      setShowCreateForm(false);
      setNewProposal({
        new_fee_bps: '',
        new_creator_share_bps: '',
        rationale_text: '',
      });
      loadGovernanceData();
    } catch (error) {
      showToast(error.message, 'error');
    }
  };

  const handleVote = async (inFavor) => {
    if (!activeProposal || !user) return;
    const token = localStorage.getItem('token');

    try {
      setVoting(true);

      const response = await fetch(`/api/governance/proposals/${activeProposal.id}/vote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ in_favor: inFavor }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to vote');
      }

      await completeGovernanceAction(
        await response.json(),
        `/api/governance/proposals/${activeProposal.id}/vote/submit-signed`,
        token
      );

      showToast('Vote recorded successfully', 'success');
      loadGovernanceData();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setVoting(false);
    }
  };

  const handleExecuteProposal = async () => {
    if (!activeProposal) return;

    try {
      const response = await fetch(`/api/governance/proposals/${activeProposal.id}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
        },
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to execute proposal');
      }

      showToast('Proposal executed successfully', 'success');
      loadGovernanceData();
    } catch (error) {
      showToast(error.message, 'error');
    }
  };

  const getTimeRemaining = (deadline) => {
    if (!deadline) return null;
    const now = new Date();
    const end = new Date(deadline);
    const diff = end - now;
    
    if (diff <= 0) return 'Voting ended';
    
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    
    if (days > 0) return `${days}d ${hours}h remaining`;
    return `${hours}h remaining`;
  };

  const getStellarExpertUrl = (contractId) => {
    if (!contractId) return '#';
    const isTestnet = import.meta.env.VITE_STELLAR_NETWORK === 'testnet';
    return isTestnet 
      ? `https://stellar.expert/testnet/contract/${contractId}`
      : `https://stellar.expert/mainnet/contract/${contractId}`;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navbar />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div className="text-center">Loading governance data...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Governance</h1>
          <p className="mt-2 text-gray-600">
            Participate in CrowdPay&apos;s decentralized governance by voting on fee changes.
          </p>
        </div>

        {/* Fee Information */}
        {feeInfo && (
          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Current Platform Fee</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <p className="text-sm text-gray-500">Platform Fee</p>
                <p className="text-2xl font-bold text-gray-900">
                  {feeInfo.platform_fee_bps} bps ({feeInfo.platform_fee_percent}%)
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Creator Revenue Share</p>
                <p className="text-2xl font-bold text-gray-900">
                  {feeInfo.creator_share_bps} bps ({feeInfo.creator_share_percent}%)
                </p>
              </div>
            </div>
            {feeInfo.contract_id && (
              <div className="mt-4">
                <a
                  href={getStellarExpertUrl(feeInfo.contract_id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:text-blue-800 text-sm"
                >
                  View contract on Stellar Expert →
                </a>
              </div>
            )}
          </div>
        )}

        {/* User Token Balance */}
        {user && userTokenBalance && (
          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Your Governance Tokens</h2>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Balance</p>
                <p className="text-2xl font-bold text-gray-900">{userTokenBalance.balance} CROWD</p>
              </div>
              <div className="text-right">
                <p className="text-sm text-gray-500">Can Propose</p>
                <p className={`text-lg font-semibold ${userTokenBalance.can_propose ? 'text-green-600' : 'text-red-600'}`}>
                  {userTokenBalance.can_propose ? 'Yes' : 'No'}
                </p>
                <p className="text-xs text-gray-400">Minimum: {userTokenBalance.min_required} CROWD</p>
              </div>
            </div>
          </div>
        )}

        {/* Active Proposal */}
        {activeProposal && (
          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Active Proposal</h2>
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-gray-500">Proposed Platform Fee</p>
                  <p className="text-lg font-semibold">
                    {activeProposal.proposed_fee_bps} bps ({(activeProposal.proposed_fee_bps / 100).toFixed(2)}%)
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Proposed Creator Share</p>
                  <p className="text-lg font-semibold">
                    {activeProposal.proposed_creator_share_bps} bps ({(activeProposal.proposed_creator_share_bps / 100).toFixed(2)}%)
                  </p>
                </div>
              </div>

              {activeProposal.rationale_text && (
                <div>
                  <p className="text-sm text-gray-500">Rationale</p>
                  <p className="text-gray-700">{activeProposal.rationale_text}</p>
                </div>
              )}

              {activeProposal.vote_stats && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <p className="text-sm text-gray-500">Votes For</p>
                    <p className="text-lg font-semibold text-green-600">{activeProposal.vote_stats.votes_for}</p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-500">Votes Against</p>
                    <p className="text-lg font-semibold text-red-600">{activeProposal.vote_stats.votes_against}</p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-500">Participation</p>
                    <p className="text-lg font-semibold text-blue-600">{activeProposal.vote_stats.participation_rate}%</p>
                  </div>
                </div>
              )}

              <div>
                <p className="text-sm text-gray-500">Time Remaining</p>
                <p className="text-lg font-semibold">{getTimeRemaining(activeProposal.deadline)}</p>
              </div>

              {activeProposal.outcome_projection && (
                <div>
                  <p className="text-sm text-gray-500">Current Outcome</p>
                  <p className={`text-lg font-semibold ${
                    activeProposal.outcome_projection === 'likely_pass' ? 'text-green-600' :
                    activeProposal.outcome_projection === 'likely_fail' ? 'text-red-600' :
                    'text-yellow-600'
                  }`}>
                    {activeProposal.outcome_projection.replace('_', ' ').toUpperCase()}
                  </p>
                </div>
              )}

              {user && activeProposal.status === 'active' && (
                <div className="flex space-x-4 pt-4 border-t">
                  <button
                    onClick={() => handleVote(true)}
                    disabled={voting}
                    className="flex-1 bg-green-600 text-white py-2 px-4 rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {voting ? 'Voting...' : 'Vote For'}
                  </button>
                  <button
                    onClick={() => handleVote(false)}
                    disabled={voting}
                    className="flex-1 bg-red-600 text-white py-2 px-4 rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {voting ? 'Voting...' : 'Vote Against'}
                  </button>
                </div>
              )}

              {activeProposal.status === 'active' && getTimeRemaining(activeProposal.deadline) === 'Voting ended' && (
                <button
                  onClick={handleExecuteProposal}
                  className="w-full bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700"
                >
                  Execute Proposal
                </button>
              )}
            </div>
          </div>
        )}

        {/* Create Proposal Form */}
        {user && userTokenBalance?.can_propose && (
          <div className="mb-6">
            {!showCreateForm ? (
              <button
                onClick={() => setShowCreateForm(true)}
                className="w-full bg-blue-600 text-white py-3 px-4 rounded-lg hover:bg-blue-700 font-semibold"
              >
                Create New Proposal
              </button>
            ) : (
              <div className="bg-white rounded-lg shadow p-6">
                <h2 className="text-xl font-semibold text-gray-900 mb-4">Create Proposal</h2>
                <form onSubmit={handleCreateProposal} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Proposed Platform Fee (basis points)
                    </label>
                    <input
                      type="number"
                      min="0"
                      max="10000"
                      required
                      value={newProposal.new_fee_bps}
                      onChange={(e) => setNewProposal({ ...newProposal, new_fee_bps: e.target.value })}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2"
                      placeholder="250 (2.5%)"
                    />
                    <p className="text-xs text-gray-500 mt-1">Enter basis points (0-10000). 100 bps = 1%</p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Proposed Creator Share (basis points)
                    </label>
                    <input
                      type="number"
                      min="0"
                      max="10000"
                      required
                      value={newProposal.new_creator_share_bps}
                      onChange={(e) => setNewProposal({ ...newProposal, new_creator_share_bps: e.target.value })}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2"
                      placeholder="500 (5%)"
                    />
                    <p className="text-xs text-gray-500 mt-1">Enter basis points (0-10000). 100 bps = 1%</p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Rationale
                    </label>
                    <textarea
                      required
                      minLength="10"
                      maxLength="1000"
                      value={newProposal.rationale_text}
                      onChange={(e) => setNewProposal({ ...newProposal, rationale_text: e.target.value })}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2"
                      rows="3"
                      placeholder="Explain why this change is needed..."
                    />
                  </div>

                  <div className="flex space-x-4">
                    <button
                      type="submit"
                      className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700"
                    >
                      Submit Proposal
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowCreateForm(false)}
                      className="flex-1 bg-gray-300 text-gray-700 py-2 px-4 rounded-lg hover:bg-gray-400"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            )}
          </div>
        )}

        {/* Proposal History */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Proposal History</h2>
          {proposals.length === 0 ? (
            <p className="text-gray-500">No proposals yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      ID
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Proposed Fee
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Creator Share
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Created
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {proposals.map((proposal) => (
                    <tr key={proposal.id}>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        #{proposal.stellar_proposal_id}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {proposal.proposed_fee_bps} bps
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {proposal.proposed_creator_share_bps} bps
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                          proposal.status === 'executed' ? 'bg-green-100 text-green-800' :
                          proposal.status === 'failed' ? 'bg-red-100 text-red-800' :
                          proposal.status === 'active' ? 'bg-blue-100 text-blue-800' :
                          'bg-gray-100 text-gray-800'
                        }`}>
                          {proposal.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {new Date(proposal.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
