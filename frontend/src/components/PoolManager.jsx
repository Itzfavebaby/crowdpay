import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import { useToast } from '../context/ToastContext';

/**
 * PoolManager — UI for creating, joining, and managing contribution pools.
 *
 * Can be embedded in the Campaign page or displayed as a standalone section.
 */
export default function PoolManager({ campaignId, campaignTitle }) {
  const { user } = useAuth();
  const { toast } = useToast();

  const [pools, setPools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [joinPoolId, setJoinPoolId] = useState(null);
  const [joinAmount, setJoinAmount] = useState('');
  const [joinName, setJoinName] = useState('');
  const [joining, setJoining] = useState(false);

  // Create form
  const [poolTitle, setPoolTitle] = useState('');
  const [poolDesc, setPoolDesc] = useState('');
  const [poolTarget, setPoolTarget] = useState('');

  const loadPools = useCallback(async () => {
    try {
      const res = await api.listCampaignPools(campaignId);
      setPools(res.data || []);
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    loadPools();
  }, [loadPools]);

  const handleCreatePool = async (e) => {
    e.preventDefault();
    if (!poolTitle.trim() || !poolTarget) return;
    setCreating(true);
    try {
      await api.createPool({
        campaign_id: campaignId,
        title: poolTitle.trim(),
        description: poolDesc.trim() || undefined,
        target_amount: parseFloat(poolTarget),
      });
      toast('Pool created! Share the link with your group.', 'success');
      setShowCreateForm(false);
      setPoolTitle('');
      setPoolDesc('');
      setPoolTarget('');
      await loadPools();
    } catch (err) {
      toast(err.message || 'Failed to create pool', 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleJoinPool = async (poolId) => {
    if (!joinAmount || parseFloat(joinAmount) <= 0) {
      toast('Enter a valid share amount', 'error');
      return;
    }
    setJoining(true);
    try {
      await api.joinPool(poolId, parseFloat(joinAmount), joinName.trim() || undefined);
      toast('You have joined the pool!', 'success');
      setJoinPoolId(null);
      setJoinAmount('');
      setJoinName('');
      await loadPools();
    } catch (err) {
      toast(err.message || 'Failed to join pool', 'error');
    } finally {
      setJoining(false);
    }
  };

  const handleLeavePool = async (poolId) => {
    try {
      await api.leavePool(poolId);
      toast('Left the pool', 'info');
      await loadPools();
    } catch (err) {
      toast(err.message || 'Failed to leave pool', 'error');
    }
  };

  const handleSubmitPool = async (pool) => {
    try {
      const res = await api.submitPool(pool.id);
      toast(res.message || 'Pool submitted!', 'success');
      await loadPools();
    } catch (err) {
      toast(err.message || 'Failed to submit pool', 'error');
    }
  };

  if (!user) {
    return (
      <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500">
        Sign in to create or join a contribution pool.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">Contribution Pools</h3>
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium"
        >
          {showCreateForm ? 'Cancel' : '+ New Pool'}
        </button>
      </div>

      {/* Create Form */}
      {showCreateForm && (
        <form onSubmit={handleCreatePool} className="bg-gray-50 rounded-lg p-4 space-y-3">
          <input
            type="text"
            placeholder="Pool name (e.g. Team Alpha)"
            value={poolTitle}
            onChange={(e) => setPoolTitle(e.target.value)}
            className="w-full px-3 py-2 border rounded-lg text-sm"
            required
            maxLength={200}
          />
          <textarea
            placeholder="Optional description..."
            value={poolDesc}
            onChange={(e) => setPoolDesc(e.target.value)}
            className="w-full px-3 py-2 border rounded-lg text-sm"
            rows={2}
            maxLength={2000}
          />
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <label className="block text-xs text-gray-500 mb-1">Target amount</label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                placeholder="100.00"
                value={poolTarget}
                onChange={(e) => setPoolTarget(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm"
                required
              />
            </div>
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create Pool'}
            </button>
          </div>
        </form>
      )}

      {/* Pool List */}
      {loading ? (
        <div className="text-center text-gray-400 py-4 text-sm">Loading pools...</div>
      ) : pools.length === 0 ? (
        <div className="text-center text-gray-400 py-8 text-sm">
          No pools yet. Be the first to create one!
        </div>
      ) : (
        <div className="space-y-3">
          {pools.map((pool) => {
            const isLeader = pool.leader_id === user.id;
            const canSubmit = isLeader && pool.status === 'open';

            return (
              <div key={pool.id} className="bg-white border rounded-lg p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h4 className="font-semibold text-gray-900">{pool.title}</h4>
                    {pool.description && (
                      <p className="text-sm text-gray-500 mt-1">{pool.description}</p>
                    )}
                  </div>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                    pool.status === 'open' ? 'bg-green-100 text-green-800' :
                    pool.status === 'submitted' ? 'bg-blue-100 text-blue-800' :
                    pool.status === 'cancelled' ? 'bg-red-100 text-red-800' :
                    'bg-gray-100 text-gray-800'
                  }`}>
                    {pool.status}
                  </span>
                </div>

                <div className="mt-3 flex items-center gap-4 text-sm text-gray-600">
                  <span>{pool.member_count} member{pool.member_count !== 1 ? 's' : ''}</span>
                  <span>Target: {parseFloat(pool.target_amount).toFixed(2)}</span>
                  {parseFloat(pool.raised_amount) > 0 && (
                    <span>Raised: {parseFloat(pool.raised_amount).toFixed(2)}</span>
                  )}
                </div>

                {/* Actions */}
                <div className="mt-3 flex gap-2">
                  {pool.status === 'open' && !isLeader && (
                    joinPoolId === pool.id ? (
                      <div className="flex gap-2 items-end flex-wrap">
                        <div>
                          <label className="block text-xs text-gray-500">Your share</label>
                          <input
                            type="number"
                            step="0.01"
                            min="0.01"
                            placeholder="10.00"
                            value={joinAmount}
                            onChange={(e) => setJoinAmount(e.target.value)}
                            className="w-28 px-2 py-1 border rounded text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500">Name (optional)</label>
                          <input
                            type="text"
                            placeholder="Display name"
                            value={joinName}
                            onChange={(e) => setJoinName(e.target.value)}
                            className="w-28 px-2 py-1 border rounded text-sm"
                            maxLength={50}
                          />
                        </div>
                        <button
                          onClick={() => handleJoinPool(pool.id)}
                          disabled={joining}
                          className="px-3 py-1.5 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700 disabled:opacity-50"
                        >
                          {joining ? 'Joining...' : 'Confirm'}
                        </button>
                        <button
                          onClick={() => { setJoinPoolId(null); setJoinAmount(''); }}
                          className="px-3 py-1.5 text-gray-500 text-sm"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setJoinPoolId(pool.id)}
                        className="px-3 py-1.5 bg-indigo-100 text-indigo-700 rounded text-sm hover:bg-indigo-200"
                      >
                        Join Pool
                      </button>
                    )
                  )}
                  {canSubmit && (
                    <button
                      onClick={() => handleSubmitPool(pool)}
                      className="px-3 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700"
                    >
                      Submit Pool
                    </button>
                  )}
                  {isLeader && pool.status === 'open' && (
                    <button
                      onClick={() => handleLeavePool(pool.id)}
                      className="px-3 py-1.5 text-red-600 text-sm hover:bg-red-50 rounded"
                    >
                      Cancel Pool
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
