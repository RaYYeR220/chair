//! Locks, locker rewards and petitions (SPEC §3).
//!
//! ## Rewards
//! The locker pool is distributed at each meeting pro rata to weight through
//! a reward-per-weight accumulator (`acc`): the meeting adds
//! `pool · 1e36 / total_weight` and moves the pool to `locker_owed`. A lock
//! earns `weight · (acc_end − acc_start) / 1e36`, and lockers withdraw with
//! `claim_rewards` (pushing NEAR to every locker at the meeting would be
//! unbounded gas).
//!
//! ## Expiry
//! A lock's weight must leave `total_weight` when it expires. Locks are
//! grouped by the hour their lock ends (`bucket = ceil(unlock_at / 1 h)`);
//! each meeting first retires every bucket whose hour has ended, recording
//! the accumulator value it stopped at (`popped`). An expired lock therefore
//! earns exactly the distributions it was counted in: at most an hour of
//! meetings after its `unlock_at`, never anything it was not part of. Sum
//! of all rewards ≤ sum of all distributions, so `locker_owed` always covers
//! every claim.
//!
//! ## Petition weight
//! A petition needs a lock that runs past the next possible meeting
//! (`max(now, next_meeting_at)`), and is queued by the weight of such locks.
//! `convene` then recomputes every queued petitioner's weight from the locks
//! still active at that moment, drops anyone at zero and briefs the three
//! heaviest. A lock that expired before the meeting counts for nobody, so
//! tokens unlocked and relocked by another account fill one slot, not two.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{assert_one_yocto, env, near, require, AccountId, NearToken, Promise};

use crate::curve::{to_u128, U256};
use crate::*;

impl Chair {
    fn set_acc(&mut self, v: U256) {
        self.acc_rpw = v.to_big_endian();
    }

    /// `(pending reward, accumulator it runs to)` of a lock right now.
    pub(crate) fn lock_reward(&self, l: &Lock) -> (u128, U256) {
        let end = match self.popped.get(&l.bucket) {
            Some(p) => U256::from_big_endian(&p.acc),
            None => self.acc(),
        };
        let start = U256::from_big_endian(&l.acc_start);
        let delta = end.saturating_sub(start);
        let r = U256::from(l.weight) * delta / U256::from(REWARD_SCALE);
        (to_u128(r).unwrap_or(u128::MAX), end)
    }

    fn settle(&self, l: &mut Lock) -> u128 {
        let (r, end) = self.lock_reward(l);
        l.acc_start = end.to_big_endian();
        r
    }

    fn expiry_list(&mut self) -> &mut Vec<u64> {
        self.expiry.get_mut().get_or_insert_with(Vec::new)
    }

    fn add_lock_weight(&mut self, bucket: u64, weight: u128) {
        match self.buckets.get_mut(&bucket) {
            Some(b) => {
                b.weight += weight;
                b.locks += 1;
            }
            None => {
                self.buckets.insert(bucket, Bucket { weight, locks: 1 });
                let list = self.expiry_list();
                if let Err(i) = list.binary_search(&bucket) {
                    list.insert(i, bucket);
                }
            }
        }
        self.total_weight += weight;
    }

    /// Takes a lock's weight out of its bucket (live or expired).
    fn drop_lock(&mut self, l: &Lock) {
        if let Some(p) = self.popped.get_mut(&l.bucket) {
            p.locks -= 1;
            if p.locks == 0 {
                self.popped.remove(&l.bucket);
            }
            return;
        }
        let b = self
            .buckets
            .get_mut(&l.bucket)
            .unwrap_or_else(|| env::panic_str("lock bucket missing"));
        b.weight -= l.weight;
        b.locks -= 1;
        let empty = b.locks == 0;
        self.total_weight -= l.weight;
        if empty {
            self.buckets.remove(&l.bucket);
            let list = self.expiry_list();
            if let Ok(i) = list.binary_search(&l.bucket) {
                list.remove(i);
            }
        }
    }

    /// Settles and removes `a`'s expired locks; returns the tokens released.
    pub(crate) fn release_expired(&mut self, a: &mut Account, now: u64) -> u128 {
        if !a.locks.iter().any(|l| l.unlock_at <= now) {
            return 0;
        }
        let mut released = 0;
        for mut l in std::mem::take(&mut a.locks) {
            if l.unlock_at <= now {
                a.claimable += self.settle(&mut l);
                self.drop_lock(&l);
                released += l.amount;
            } else {
                a.locks.push(l);
            }
        }
        released
    }

    /// Retires buckets whose hour has ended (at most `MAX_EXPIRY_POPS`).
    pub(crate) fn pop_expired(&mut self, now: u64) -> usize {
        let acc = self.acc_rpw;
        let list = self.expiry_list();
        let n = list
            .iter()
            .take(MAX_EXPIRY_POPS)
            .take_while(|h| **h * HOUR_NS <= now)
            .count();
        let due: Vec<u64> = list.drain(..n).collect();
        for h in &due {
            if let Some(b) = self.buckets.remove(h) {
                self.total_weight -= b.weight;
                self.popped.insert(*h, Popped { acc, locks: b.locks });
            }
        }
        due.len()
    }

    /// The meeting's locker payout: retire expired weight, then credit the
    /// whole pool pro rata to the remaining weight. Returns NEAR distributed
    /// (0 with no lockers: the pool carries over).
    pub(crate) fn pay_lockers(&mut self, now: u64) -> u128 {
        self.pop_expired(now);
        let pool = self.locker_pool;
        if pool == 0 || self.total_weight == 0 {
            return 0;
        }
        let inc = U256::from(pool) * U256::from(REWARD_SCALE) / U256::from(self.total_weight);
        if inc.is_zero() {
            return 0;
        }
        self.set_acc(self.acc() + inc);
        self.locker_pool = 0;
        self.locker_owed += pool;
        self.stats.locker_rewards_paid.0 += pool;
        pool
    }

    /// Weight of `a`'s locks still active after `t` (`unlock_at > t`).
    pub(crate) fn active_weight(a: &Account, t: u64) -> u128 {
        a.locks
            .iter()
            .filter(|l| l.unlock_at > t)
            .map(|l| l.weight)
            .sum()
    }

    /// The brief's petitions at `now` (SPEC §3): each queued petitioner's
    /// weight recomputed from their locks still active at `now`, petitioners
    /// at zero dropped, the three heaviest kept (earlier filing wins ties).
    pub(crate) fn brief_petitions(&self, queue: &[Petition], now: u64) -> Vec<Petition> {
        let mut out: Vec<Petition> = queue
            .iter()
            .filter_map(|p| {
                let w = self
                    .accounts
                    .get(&p.account)
                    .map_or(0, |a| Self::active_weight(a, now));
                (w > 0).then(|| Petition {
                    weight: U128(w),
                    ..p.clone()
                })
            })
            .collect();
        // Stable: equal weights keep queue order, which is filing order
        // among equal filing weights.
        out.sort_by(|a, b| {
            b.weight
                .0
                .cmp(&a.weight.0)
                .then(a.filed_at.0.cmp(&b.filed_at.0))
        });
        out.truncate(TOP_PETITIONS);
        out
    }

    fn lock_view(&self, l: &Lock, now: u64) -> LockView {
        LockView {
            id: l.id,
            amount: U128(l.amount),
            days: l.days,
            weight: U128(l.weight),
            start: U64(l.start),
            unlock_at: U64(l.unlock_at),
            active: l.unlock_at > now,
            pending_reward: U128(self.lock_reward(l).0),
        }
    }
}

#[near]
impl Chair {
    /// Locks `amount` unlocked CHAIR for `days` ∈ {1, 7, 30}: weight
    /// `amount × days`, no movement until `unlock_at`. 1 yoctoNEAR.
    #[payable]
    pub fn lock(&mut self, amount: U128, days: u8) -> LockView {
        assert_one_yocto();
        require!(LOCK_DAYS.contains(&days), "days must be 1, 7 or 30");
        let amount = amount.0;
        require!(amount > 0, "amount must be positive");
        let id = env::predecessor_account_id();
        let now = env::block_timestamp();
        let mut a = self.account_or_panic(&id);
        self.release_expired(&mut a, now);
        require!(a.locks.len() < MAX_LOCKS, "at most 8 locks per account");
        let free = a.balance - Self::locked_amount(&a, now);
        require!(amount <= free, "not enough unlocked CHAIR");
        let unlock_at = now + days as u64 * DAY_NS;
        let bucket = unlock_at.div_ceil(HOUR_NS);
        let weight = amount
            .checked_mul(days as u128)
            .unwrap_or_else(|| env::panic_str("weight overflow"));
        self.add_lock_weight(bucket, weight);
        let lock = Lock {
            id: a.next_lock_id,
            amount,
            days,
            weight,
            start: now,
            unlock_at,
            bucket,
            acc_start: self.acc_rpw,
        };
        a.next_lock_id += 1;
        a.locks.push(lock.clone());
        self.accounts.insert(id.clone(), a);
        events::emit(
            "lock",
            &json!({
                "account_id": id,
                "lock_id": lock.id,
                "amount": U128(amount),
                "days": days,
                "weight": U128(weight),
                "unlock_at": U64(unlock_at),
            }),
        );
        self.lock_view(&lock, now)
    }

    /// Releases every expired lock of the caller, settling its rewards into
    /// `claimable`. Returns the tokens released. (Expired tokens are already
    /// transferable; this also frees their storage.)
    pub fn unlock(&mut self) -> U128 {
        let id = env::predecessor_account_id();
        let now = env::block_timestamp();
        let mut a = self.account_or_panic(&id);
        let released = self.release_expired(&mut a, now);
        self.accounts.insert(id.clone(), a);
        if released > 0 {
            events::emit(
                "unlock",
                &json!({ "account_id": id, "amount": U128(released) }),
            );
        }
        U128(released)
    }

    /// Pays the caller's locker rewards (settled and pending) in NEAR.
    pub fn claim_rewards(&mut self) -> U128 {
        let id = env::predecessor_account_id();
        let now = env::block_timestamp();
        let mut a = self.account_or_panic(&id);
        self.release_expired(&mut a, now);
        let mut locks = std::mem::take(&mut a.locks);
        for l in locks.iter_mut() {
            a.claimable += self.settle(l);
        }
        a.locks = locks;
        let amount = a.claimable;
        a.claimable = 0;
        self.accounts.insert(id.clone(), a);
        if amount > 0 {
            self.locker_owed -= amount;
            events::emit(
                "rewards_claimed",
                &json!({ "account_id": id, "amount": U128(amount) }),
            );
            Promise::new(id)
                .transfer(NearToken::from_yoctonear(amount))
                .detach();
        }
        U128(amount)
    }

    /// Files a petition for the next meeting (≤ 280 characters, no control
    /// characters). Only a locker with a lock that runs past the next
    /// possible meeting, one per 24 h; the fixed fee is burned from unlocked
    /// CHAIR. The petition is queued by the weight of those locks (at most
    /// `MAX_PENDING_PETITIONS`, the lightest drops; a newer petition from
    /// the same account replaces its queued one). At `convene` every
    /// weight is recomputed from the locks still active then, and the three
    /// heaviest (earlier filing wins ties) reach the brief. 1 yoctoNEAR.
    #[payable]
    pub fn petition(&mut self, text: String) -> Petition {
        assert_one_yocto();
        let chars = text.chars().count();
        require!(
            chars > 0 && chars <= PETITION_MAX_CHARS,
            "petition must be 1-280 characters"
        );
        require!(
            !text.chars().any(char::is_control),
            "petition must not contain control characters"
        );
        let id = env::predecessor_account_id();
        let now = env::block_timestamp();
        let mut a = self.account_or_panic(&id);
        self.release_expired(&mut a, now);
        // The earliest the next meeting can convene: only locks still active
        // then can count in its brief.
        let next_meeting = self.next_meeting_at.max(now);
        let weight = Self::active_weight(&a, next_meeting);
        require!(
            weight > 0,
            "only lockers may petition, with a lock that runs past the next meeting"
        );
        require!(
            a.last_petition_at == 0 || now >= a.last_petition_at + DAY_NS,
            "one petition per day"
        );
        let free = a.balance - Self::locked_amount(&a, now);
        require!(free >= self.petition_fee, "the petition fee needs unlocked CHAIR");
        a.balance -= self.petition_fee;
        a.last_petition_at = now;
        self.accounts.insert(id.clone(), a);
        self.burn_supply(self.petition_fee);
        self.stats.petitions += 1;
        self.stats.petition_fees_burned.0 += self.petition_fee;
        events::ft_burn(&id, self.petition_fee, Some("petition fee"));

        let p = Petition {
            account: id,
            weight: U128(weight),
            text,
            filed_at: U64(now),
        };
        self.petitions_filed += 1;
        let queue = self.petitions.get_mut().get_or_insert_with(Vec::new);
        // One petition per account in the queue: with meetings more than a
        // day apart, a newer one replaces the older.
        queue.retain(|q| q.account != p.account);
        let pos = queue
            .iter()
            .position(|q| q.weight.0 < weight)
            .unwrap_or(queue.len());
        if pos < MAX_PENDING_PETITIONS {
            queue.insert(pos, p.clone());
            queue.truncate(MAX_PENDING_PETITIONS);
        }
        events::emit(
            "petition_filed",
            &json!({
                "account_id": p.account,
                "weight": p.weight,
                "text": p.text,
                "meeting": self.meeting_count + 1,
                // Provisional: weights are recomputed at `convene`.
                "in_brief": pos < TOP_PETITIONS,
                "queued": pos < MAX_PENDING_PETITIONS,
            }),
        );
        p
    }

    pub fn get_account(&self, account_id: AccountId) -> Option<AccountView> {
        let a = self.accounts.get(&account_id)?;
        let now = env::block_timestamp();
        let locks: Vec<LockView> = a.locks.iter().map(|l| self.lock_view(l, now)).collect();
        let locked = Self::locked_amount(a, now);
        let pending: u128 = locks.iter().map(|l| l.pending_reward.0).sum();
        Some(AccountView {
            account_id,
            balance: U128(a.balance),
            locked: U128(locked),
            transferable: U128(a.balance - locked),
            active_weight: U128(Self::active_weight(a, now)),
            claimable: U128(a.claimable),
            rewards: U128(a.claimable + pending),
            last_petition_at: U64(a.last_petition_at),
            locks,
        })
    }
}
