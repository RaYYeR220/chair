//! Fuzz / invariant test. Random sequences of buys, sells, transfers, locks,
//! petitions, claims, endowment reports, time jumps and meetings whose
//! rulings are valid, jailbroken, forged, unparseable, missing, failed,
//! duplicated or never delivered (lapsing into the fallback at the next
//! convene). After every step:
//!
//! - `reserve ≥ ∫₀ˢ p` exactly, and `reserve == ceil(∫₀ˢ p)` (path independence)
//! - `supply == Σ balances` and `s == supply + burned`
//! - every lever inside the constitution, and no meeting moved one by more
//!   than its step
//! - NEAR conservation: `in − out == reserve + buyback + locker_pool +
//!   locker_owed + endowment_pending`
//! - locker rewards owed to accounts `≤ locker_owed`
//! - `total_weight == Σ live bucket weights`

use super::*;

/// Defaults; override with `CHAIR_FUZZ_SEEDS` / `CHAIR_FUZZ_STEPS`.
const SEEDS: u64 = 48;
const STEPS: u64 = 400;

fn env_or(key: &str, default: u64) -> u64 {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

#[derive(Default, Debug)]
struct Counts {
    buys: u64,
    sells: u64,
    transfers: u64,
    locks: u64,
    petitions: u64,
    claims: u64,
    meetings: u64,
    rulings: u64,
    clamped: u64,
    fallbacks: u64,
    lapsed: u64,
    ignored: u64,
    buybacks: u64,
    gateway: u64,
    /// Meetings that left `locker_share` at the constitution's ceiling.
    locker_at_max: u64,
}

struct Fz {
    h: H,
    rng: Rng,
    actors: Vec<AccountId>,
    near_in: u128,
    near_out: u128,
    counts: Counts,
    op: &'static str,
}

fn content_for(rng: &mut Rng, before: Levers, petitions: usize) -> String {
    let answers: Vec<String> = (0..petitions).map(|i| format!("answer {i}")).collect();
    let (t, e, l, b) = if rng.chance(35) {
        // Jailbroken: anything at all.
        let wild = |r: &mut Rng| match r.below(4) {
            0 => i64::MAX,
            1 => i64::MIN,
            2 => r.range(-100_000, 100_000),
            _ => r.range(-5, 400),
        };
        (wild(rng), wild(rng), wild(rng), wild(rng))
    } else {
        // Plausible: within one step of the levers in force (the bounds
        // still clamp near the edges, e.g. locker_share at its ceiling).
        use constitution::*;
        (
            before.tax_bps as i64 + rng.range(-TAX_STEP_BPS, TAX_STEP_BPS),
            before.endowment_share as i64 + rng.range(-ENDOWMENT_STEP, ENDOWMENT_STEP),
            before.locker_share as i64 + rng.range(-LOCKER_STEP, LOCKER_STEP),
            rng.range(0, BUYBACK_MAX_BPS),
        )
    };
    json!({
        "tax_bps": t, "endowment_share": e, "locker_share": l, "buyback_burn": b,
        "minutes": "fuzz minutes \"quoted\"", "answers": answers,
    })
    .to_string()
}

impl Fz {
    fn new(seed: u64) -> Self {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15 ^ (seed + 1).wrapping_mul(0x1000_0000_01b3));
        // Launch levers anywhere inside the constitution.
        use constitution::*;
        let e = rng.range(ENDOWMENT_MIN, ENDOWMENT_MAX);
        let levers = Levers {
            tax_bps: rng.range(TAX_MIN_BPS, TAX_MAX_BPS) as u16,
            endowment_share: e as u8,
            locker_share: rng.range(LOCKER_MIN, (100 - e).min(LOCKER_MAX)) as u8,
        };
        assert!(levers.within_constitution());
        Fz {
            h: H::with_levers(Some(levers)),
            rng,
            actors: (0..5).map(|i| acc(&format!("f{i}.near"))).collect(),
            near_in: 0,
            near_out: 0,
            counts: Counts::default(),
            op: "",
        }
    }

    fn actor(&mut self) -> AccountId {
        let i = self.rng.below(self.actors.len() as u64) as usize;
        self.actors[i].clone()
    }

    fn view(&self, a: &AccountId) -> Option<AccountView> {
        self.h.as_(a, 0);
        self.h.c.get_account(a.clone())
    }

    fn buy(&mut self) {
        let a = self.actor();
        let registered = self.view(&a).is_some();
        let dep = milli(30) + self.rng.log_u128(76) % near(60);
        let r = self.h.buy(&a, dep);
        let storage = if registered { 0 } else { STORAGE_DEPOSIT };
        assert_eq!(storage + r.cost.0 + r.tax.0 + r.refund.0, dep);
        self.near_in += dep - storage - r.refund.0;
        self.counts.buys += 1;
    }

    fn sell(&mut self) {
        let a = self.actor();
        let Some(v) = self.view(&a) else { return };
        if v.transferable.0 == 0 {
            return;
        }
        let amount = 1 + (self.rng.log_u128(127) % v.transferable.0);
        let r = self.h.sell(&a, amount);
        if r.near_out.0 > 0 {
            assert!(transfers().contains(&(a.to_string(), r.near_out.0)));
        }
        self.near_out += r.near_out.0;
        self.counts.sells += 1;
    }

    fn transfer(&mut self) {
        let a = self.actor();
        let b = self.actor();
        if a == b {
            return;
        }
        let (Some(v), Some(_)) = (self.view(&a), self.view(&b)) else {
            return;
        };
        if v.transferable.0 == 0 {
            return;
        }
        let amount = 1 + (self.rng.log_u128(127) % v.transferable.0);
        self.h.as_(&a, 1);
        self.h.c.ft_transfer(b, U128(amount), None);
        self.counts.transfers += 1;
    }

    fn lock(&mut self) {
        let a = self.actor();
        let Some(v) = self.view(&a) else { return };
        let now = self.h.now;
        let live = v.locks.iter().filter(|l| l.unlock_at.0 > now).count();
        if v.transferable.0 == 0 || live >= MAX_LOCKS {
            return;
        }
        let amount = 1 + (self.rng.log_u128(127) % v.transferable.0);
        let days = [1u8, 7, 30][self.rng.below(3) as usize];
        self.h.lock(&a, amount, days);
        self.counts.locks += 1;
    }

    fn petition(&mut self) {
        let a = self.actor();
        let Some(v) = self.view(&a) else { return };
        let now = self.h.now;
        // Only locks that outlast the next possible meeting can petition.
        let next = self.h.c.next_meeting_at.max(now);
        let weight: u128 = v
            .locks
            .iter()
            .filter(|l| l.unlock_at.0 > next)
            .map(|l| l.weight.0)
            .sum();
        if weight == 0
            || v.transferable.0 < FEE
            || (v.last_petition_at.0 != 0 && now < v.last_petition_at.0 + DAY_NS)
        {
            return;
        }
        let len = 1 + self.rng.below(280) as usize;
        let alphabet = ['"', '\\', 'a', 'Z', '{', '}', '🪑', ' '];
        let text: String = (0..len)
            .map(|_| alphabet[self.rng.below(8) as usize])
            .collect();
        self.h.petition(&a, &text);
        self.counts.petitions += 1;
    }

    fn claim(&mut self) {
        let a = self.actor();
        if self.view(&a).is_none() {
            return;
        }
        self.h.as_(&a, 0);
        if self.rng.chance(50) {
            self.h.c.unlock();
        } else {
            let got = self.h.c.claim_rewards().0;
            self.near_out += got;
            self.counts.claims += 1;
        }
    }

    fn report(&mut self) {
        let amount = if self.rng.chance(25) {
            self.rng.log_u128(80) % near(1)
        } else {
            near(1) + self.rng.log_u128(80) % near(1_000)
        };
        self.h.report(amount);
    }

    fn meeting(&mut self) {
        let mut before = self.h.c.levers;
        let lapsing = self.h.c.open_meeting;
        let out = self.h.convene();
        self.counts.meetings += 1;
        if let Some(n) = lapsing {
            // The unanswered meeting ran the fallback first.
            let m = self.h.meeting(n);
            assert_eq!(m.status, MeetingStatus::Lapsed);
            let o = m.outcome.unwrap();
            assert_eq!(o.kind, OutcomeKind::Fallback);
            assert_eq!(o.reason.as_deref(), Some("lapsed"));
            assert_eq!(o.levers, constitution::fallback(before));
            assert_eq!(o.buyback_tokens.0, 0);
            self.near_out += o.endowment_sent.0;
            self.counts.fallbacks += 1;
            self.counts.lapsed += 1;
            before = o.levers;
        }
        let n = self.h.c.meeting_count;
        if let PromiseOrValue::Value(_) = out {
            let o = self.h.outcome(n);
            assert_eq!(o.reason.as_deref(), Some("asleep"));
            self.near_out += o.endowment_sent.0;
            self.counts.fallbacks += 1;
            self.check_meeting(before, &o);
            return;
        }
        let petitions = self.h.meeting(n).petitions as usize;
        let roll = self.rng.below(100);
        let signed = |f: &Fz, content: &str, sk: &SigningKey| {
            let (r, t, s) = f.h.signed(n, content, sk);
            PromiseResult::Successful(courier(&r, &t, &s))
        };
        let gateway = |f: &Fz, content: &str, sk: &SigningKey| {
            let (r, t, s) = f.h.signed_gateway(n, content, sk);
            PromiseResult::Successful(courier(&r, &t, &s))
        };
        let (result, expect): (Option<PromiseResult>, Option<&str>) = if roll < 35 {
            let content = content_for(&mut self.rng, before, petitions);
            (Some(signed(self, &content, &model_sk())), None)
        } else if roll < 45 {
            let content = content_for(&mut self.rng, before, petitions);
            (Some(gateway(self, &content, &gateway_sk())), None)
        } else if roll < 51 {
            let content = content_for(&mut self.rng, before, petitions);
            (Some(signed(self, &content, &other_sk())), Some("bad_signature"))
        } else if roll < 53 {
            // Cross-kind: a model key on a gateway text.
            let content = content_for(&mut self.rng, before, petitions);
            (Some(gateway(self, &content, &model_sk())), Some("bad_signature"))
        } else if roll < 55 {
            // Cross-kind: a gateway key on a model text.
            let content = content_for(&mut self.rng, before, petitions);
            (Some(signed(self, &content, &gateway_sk())), Some("bad_signature"))
        } else if roll < 62 {
            (
                Some(signed(self, "{\"tax_bps\": \"high\"}", &model_sk())),
                Some("unparseable"),
            )
        } else if roll < 68 {
            let content = content_for(&mut self.rng, before, petitions);
            let (r, t, s) = self.h.signed(n, &content, &model_sk());
            let tampered = r.replace("fuzz", "FUZZ");
            (
                Some(PromiseResult::Successful(courier(&tampered, &t, &s))),
                Some("bad_hash"),
            )
        } else if roll < 76 {
            (Some(PromiseResult::Successful(b"null".to_vec())), Some("unsigned"))
        } else if roll < 82 {
            (Some(PromiseResult::Failed), Some("unsigned"))
        } else {
            (None, None) // never delivered: lapses at the next convene
        };
        let Some(result) = result else { return };
        let m = self.h.deliver(n, result).unwrap();
        let o = m.outcome.clone().unwrap();
        assert_eq!(o.reason.as_deref(), expect);
        self.near_out += o.endowment_sent.0;
        match o.kind {
            OutcomeKind::Ruling => {
                self.counts.rulings += 1;
                if o.signed_by.as_deref() == Some("gateway") {
                    self.counts.gateway += 1;
                }
                if !o.clamps.is_empty() {
                    self.counts.clamped += 1;
                }
            }
            OutcomeKind::Fallback => self.counts.fallbacks += 1,
        }
        if o.buyback_tokens.0 > 0 {
            self.counts.buybacks += 1;
        }
        self.check_meeting(before, &o);
        if o.levers.locker_share as i64 == constitution::LOCKER_MAX {
            self.counts.locker_at_max += 1;
        }
        // A re-roll for the same meeting never counts.
        if self.rng.chance(20) {
            let content = content_for(&mut self.rng, self.h.c.levers, petitions);
            let again = signed(self, &content, &model_sk());
            let c = &self.h.c;
            let snapshot = (c.levers, c.reserve, c.sold, c.buyback_fund, c.locker_owed);
            self.h.deliver(n, again);
            let c = &self.h.c;
            assert_eq!(
                snapshot,
                (c.levers, c.reserve, c.sold, c.buyback_fund, c.locker_owed)
            );
            self.counts.ignored += 1;
        }
    }

    fn check_meeting(&self, before: Levers, o: &Outcome) {
        let l = o.levers;
        assert_eq!(l, self.h.c.levers);
        assert!(l.within_constitution());
        assert!((l.tax_bps as i64 - before.tax_bps as i64).abs() <= constitution::TAX_STEP_BPS);
        assert!(
            (l.endowment_share as i64 - before.endowment_share as i64).abs()
                <= constitution::ENDOWMENT_STEP
        );
        assert!(
            (l.locker_share as i64 - before.locker_share as i64).abs() <= constitution::LOCKER_STEP
        );
        assert!(o.buyback_bps as i64 <= constitution::BUYBACK_MAX_BPS);
        assert!(l.locker_share as i64 <= constitution::LOCKER_MAX);
        if o.kind == OutcomeKind::Fallback {
            assert_eq!(l, constitution::fallback(before));
            assert_eq!(o.buyback_tokens.0, 0);
        }
    }

    fn run(&mut self, op: &'static str, f: fn(&mut Fz)) {
        self.op = op;
        f(self);
    }

    fn step(&mut self) {
        match self.rng.below(100) {
            0..=21 => self.run("buy", Fz::buy),
            22..=33 => self.run("sell", Fz::sell),
            34..=40 => self.run("transfer", Fz::transfer),
            41..=50 => self.run("lock", Fz::lock),
            51..=56 => self.run("petition", Fz::petition),
            57..=63 => self.run("claim", Fz::claim),
            64..=68 => self.run("report", Fz::report),
            69..=88 => self.run("meeting", Fz::meeting),
            _ => {
                self.op = "advance";
                let jump = self.rng.below(3 * DAY_NS);
                self.h.advance(jump);
            }
        }
        self.check();
    }

    fn check(&self) {
        self.h.as_(&self.actors[0], 0);
        let c = &self.h.c;
        let curve = c.curve();
        assert!(curve.covers(c.reserve, c.sold), "reserve below the curve integral");
        assert_eq!(Some(c.reserve), curve.reserve_for(c.sold));
        assert_eq!(c.sold, c.supply + c.burned);

        let mut balances = 0u128;
        let mut owed = 0u128;
        for a in &self.actors {
            if let Some(v) = c.get_account(a.clone()) {
                balances += v.balance.0;
                owed += v.rewards.0;
                assert!(v.locked.0 <= v.balance.0);
            }
        }
        assert_eq!(c.supply, balances, "supply != sum of balances after {}", self.op);
        assert!(owed <= c.locker_owed, "rewards {owed} > owed {}", c.locker_owed);
        assert!(c.levers.within_constitution());

        let held = c.reserve + c.buyback_fund + c.locker_pool + c.locker_owed + c.endowment_pending;
        assert_eq!(self.near_in - self.near_out, held, "NEAR not conserved");

        let live: u128 = c
            .expiry
            .get()
            .as_ref()
            .unwrap()
            .iter()
            .map(|h| c.buckets.get(h).unwrap().weight)
            .sum();
        assert_eq!(c.total_weight, live);
    }
}

#[test]
fn fuzz_invariants_hold_over_random_histories() {
    let (seeds, steps) = (env_or("CHAIR_FUZZ_SEEDS", SEEDS), env_or("CHAIR_FUZZ_STEPS", STEPS));
    let mut total = Counts::default();
    for seed in 0..seeds {
        let mut f = Fz::new(seed);
        for _ in 0..steps {
            f.step();
        }
        let c = &f.counts;
        total.buys += c.buys;
        total.sells += c.sells;
        total.transfers += c.transfers;
        total.locks += c.locks;
        total.petitions += c.petitions;
        total.claims += c.claims;
        total.meetings += c.meetings;
        total.rulings += c.rulings;
        total.clamped += c.clamped;
        total.fallbacks += c.fallbacks;
        total.lapsed += c.lapsed;
        total.ignored += c.ignored;
        total.buybacks += c.buybacks;
        total.gateway += c.gateway;
        total.locker_at_max += c.locker_at_max;
    }
    println!(
        "fuzz: {seeds} seeds x {steps} steps = {} steps; {total:?}",
        seeds * steps
    );
    // The run actually exercised every path.
    for (name, n) in [
        ("buys", total.buys),
        ("sells", total.sells),
        ("transfers", total.transfers),
        ("locks", total.locks),
        ("petitions", total.petitions),
        ("claims", total.claims),
        ("rulings", total.rulings),
        ("clamped", total.clamped),
        ("fallbacks", total.fallbacks),
        ("lapsed", total.lapsed),
        ("ignored", total.ignored),
        ("buybacks", total.buybacks),
        ("gateway rulings", total.gateway),
        ("locker_share at its ceiling", total.locker_at_max),
    ] {
        assert!(n * 2_000 >= seeds * steps, "{name} only {n}");
    }
}
