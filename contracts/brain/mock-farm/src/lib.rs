//! Testnet stand-in for the `stake.dao` farm methods the brain calls.
//!
//! Same method names, arguments, deposits and gas floors as
//! `house-of-stake-contracts/staking-contract` at 74b039c:
//! `storage_deposit`, `stake(product_id, price_id?)`, `unstake(product_id, amount?)`,
//! `withdraw(validator_id)`, `get_farm_position`, `get_price`.
//! No validator pool: staked NEAR stays in this contract, the unstake delay is
//! a configurable number of seconds and rewards accrue linearly.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise};

const EPOCH_SETTLEMENT_MIN_GAS: Gas = Gas::from_tgas(300);

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FarmStatus {
    Active,
    Closed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct FarmPosition {
    pub account_id: AccountId,
    pub product_id: String,
    pub price_id: String,
    pub validator_id: AccountId,
    pub shares: U128,
    pub reward_debt: U128,
    pub accrued_reward_units: U128,
    pub status: FarmStatus,
    pub created_ns: U64,
    pub updated_ns: U64,
}

#[near(serializers = [json])]
pub struct FarmPositionView {
    pub account_id: AccountId,
    pub product_id: String,
    pub price_id: String,
    pub validator_id: AccountId,
    pub shares: U128,
    pub staked_near_amount: U128,
    pub reward_debt: U128,
    pub accrued_reward_units: U128,
    pub pending_reward_units: U128,
    pub total_earned_reward_units: U128,
    pub status: FarmStatus,
    pub created_ns: U64,
    pub updated_ns: U64,
}

#[near(serializers = [json])]
pub struct PriceView {
    pub price_id: String,
    pub product_id: String,
    pub amount: U128,
    pub price_type: String,
    pub status: String,
}

#[near(serializers = [borsh])]
pub struct Pending {
    amount: u128,
    ready_ns: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockFarm {
    owner: AccountId,
    product_id: String,
    price_id: String,
    price_status: String,
    validator_id: AccountId,
    min_amount: u128,
    min_storage: u128,
    per_position_storage: u128,
    unstake_delay_ns: u64,
    storage: LookupMap<AccountId, u128>,
    positions: LookupMap<AccountId, FarmPosition>,
    pending: LookupMap<AccountId, Pending>,
}

#[near]
impl MockFarm {
    #[init]
    pub fn new(owner: AccountId, product_id: String, price_id: String, validator_id: AccountId, unstake_delay_sec: u64) -> Self {
        Self {
            owner,
            product_id,
            price_id,
            price_status: "Active".into(),
            validator_id,
            min_amount: NearToken::from_near(1).as_yoctonear(),
            min_storage: NearToken::from_millinear(10).as_yoctonear(),
            per_position_storage: NearToken::from_millinear(5).as_yoctonear(),
            unstake_delay_ns: unstake_delay_sec * 1_000_000_000,
            storage: LookupMap::new(b"s"),
            positions: LookupMap::new(b"p"),
            pending: LookupMap::new(b"u"),
        }
    }

    /// Owner: archive or reactivate the price (to exercise `retire_position`).
    pub fn set_price_status(&mut self, status: String) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        self.price_status = status;
    }

    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> U128 {
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        let attached = env::attached_deposit().as_yoctonear();
        let current = self.storage.get(&account).copied().unwrap_or(0);
        let accepted = if registration_only.unwrap_or(false) {
            self.min_storage.saturating_sub(current).min(attached)
        } else {
            require!(attached > 0, "Attach NEAR for storage");
            attached
        };
        require!(current + accepted >= self.min_storage, "Attached deposit is less than the minimum storage balance");
        self.storage.insert(account, current + accepted);
        if attached > accepted {
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(attached - accepted))
                .detach();
        }
        U128(current + accepted)
    }

    #[payable]
    pub fn stake(&mut self, product_id: String, price_id: Option<String>) -> FarmPosition {
        require!(env::prepaid_gas() >= EPOCH_SETTLEMENT_MIN_GAS, "Insufficient gas");
        let account = env::predecessor_account_id();
        let storage = self.storage.get(&account).copied().unwrap_or_else(|| env::panic_str("Account is not registered"));
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= self.min_amount, "Attached NEAR is below the contract minimum lock amount (min_lock_amount)");
        require!(product_id == self.product_id, "Unknown product");
        let price_id = price_id.unwrap_or_else(|| self.price_id.clone());
        require!(price_id == self.price_id, "This price is not a farm price");
        require!(self.price_status == "Active", "This farm price is archived or inactive");
        let now = env::block_timestamp();
        let position = match self.positions.get(&account).cloned() {
            Some(mut p) if p.status == FarmStatus::Active => {
                require!(p.price_id == price_id, "Existing farm position uses a different price");
                p.accrued_reward_units = U128(self.pending_rewards(&p, now));
                p.shares = U128(p.shares.0 + deposit);
                p.updated_ns = U64(now);
                p
            }
            _ => {
                require!(
                    storage >= self.min_storage + self.per_position_storage,
                    "Top up storage for another farm position"
                );
                FarmPosition {
                    account_id: account.clone(),
                    product_id,
                    price_id,
                    validator_id: self.validator_id.clone(),
                    shares: U128(deposit),
                    reward_debt: U128(0),
                    accrued_reward_units: U128(0),
                    status: FarmStatus::Active,
                    created_ns: U64(now),
                    updated_ns: U64(now),
                }
            }
        };
        self.positions.insert(account, position.clone());
        position
    }

    #[payable]
    pub fn unstake(&mut self, product_id: String, amount: Option<U128>) {
        require!(env::prepaid_gas() >= EPOCH_SETTLEMENT_MIN_GAS, "Insufficient gas");
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "Requires attached deposit of exactly 1 yoctoNEAR");
        require!(product_id == self.product_id, "Unknown product");
        let account = env::predecessor_account_id();
        let mut p = self.positions.get(&account).cloned().unwrap_or_else(|| env::panic_str("No farm position"));
        require!(p.status == FarmStatus::Active, "No active farm position");
        let now = env::block_timestamp();
        let out = amount.map(|a| a.0).unwrap_or(p.shares.0).min(p.shares.0);
        p.accrued_reward_units = U128(self.pending_rewards(&p, now));
        p.shares = U128(p.shares.0 - out);
        if p.shares.0 == 0 {
            p.status = FarmStatus::Closed;
        }
        p.updated_ns = U64(now);
        self.positions.insert(account.clone(), p);
        let prev = self.pending.get(&account).map(|q| q.amount).unwrap_or(0);
        self.pending.insert(account, Pending { amount: prev + out, ready_ns: now + self.unstake_delay_ns });
    }

    #[payable]
    pub fn withdraw(&mut self, validator_id: AccountId) -> Promise {
        require!(env::prepaid_gas() >= EPOCH_SETTLEMENT_MIN_GAS, "Insufficient gas");
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "Requires attached deposit of exactly 1 yoctoNEAR");
        require!(validator_id == self.validator_id, "Unknown validator");
        let account = env::predecessor_account_id();
        let q = self
            .pending
            .remove(&account)
            .unwrap_or_else(|| env::panic_str("You have no unlocked NEAR waiting to claim for this validator"));
        require!(env::block_timestamp() >= q.ready_ns, "Unstaked NEAR is not withdrawable yet");
        Promise::new(account).transfer(NearToken::from_yoctonear(q.amount))
    }

    pub fn get_farm_position(&self, account_id: AccountId, product_id: String) -> Option<FarmPositionView> {
        if product_id != self.product_id {
            return None;
        }
        self.positions.get(&account_id).map(|p| self.view(p))
    }

    pub fn get_price(&self, price_id: String) -> Option<PriceView> {
        (price_id == self.price_id).then(|| PriceView {
            price_id: self.price_id.clone(),
            product_id: self.product_id.clone(),
            amount: U128(self.min_amount),
            price_type: "Farm".into(),
            status: self.price_status.clone(),
        })
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<U128> {
        self.storage.get(&account_id).map(|v| U128(*v))
    }
}

impl MockFarm {
    /// One reward unit (1e24) per staked NEAR per day.
    fn pending_rewards(&self, p: &FarmPosition, now: u64) -> u128 {
        if p.status != FarmStatus::Active {
            return p.accrued_reward_units.0;
        }
        let elapsed = u128::from(now.saturating_sub(p.updated_ns.0));
        p.accrued_reward_units.0 + p.shares.0 * elapsed / 86_400_000_000_000
    }

    fn view(&self, p: &FarmPosition) -> FarmPositionView {
        let pending = self.pending_rewards(p, env::block_timestamp());
        let staked = if p.status == FarmStatus::Active { p.shares.0 } else { 0 };
        FarmPositionView {
            account_id: p.account_id.clone(),
            product_id: p.product_id.clone(),
            price_id: p.price_id.clone(),
            validator_id: p.validator_id.clone(),
            shares: p.shares,
            staked_near_amount: U128(staked),
            reward_debt: p.reward_debt,
            accrued_reward_units: p.accrued_reward_units,
            pending_reward_units: U128(pending),
            total_earned_reward_units: U128(pending),
            status: p.status.clone(),
            created_ns: p.created_ns,
            updated_ns: p.updated_ns,
        }
    }
}
