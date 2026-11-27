//! Who is connected: phones and their seats, avatars and rate limits, the guide,
//! watchers, joining and leaving.

use super::*;

/// A visitor's name for their phone: trimmed, without control characters, at most
/// `NAME_CHARS` long. An empty name means the fun name again.
pub(super) fn clean_name(name: &str) -> Result<Option<String>, String> {
    let name: String = name.chars().filter(|c| !c.is_control()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    if name.chars().count() > NAME_CHARS {
        return Err(format!("a name is at most {NAME_CHARS} characters"));
    }
    Ok((!name.is_empty()).then_some(name))
}

impl Hub {
    /// Where the guide's phone joins (#98): the code, and the address when phones can reach the host.
    pub fn guide(&self) -> Value {
        let session = self.session();
        let base = session.join_url.as_deref().and_then(|url| url.rsplit_once("/phone?").map(|(base, _)| base.to_string()));
        json!({ "code": self.guide_code, "url": base.map(|base| format!("{base}/guide?g={}", self.guide_code)) })
    }

    pub fn session(&self) -> SessionInfo {
        let mut session = self.session.clone();
        session.language = self.language.read().clone();
        session.sound = *self.sound.read();
        session.ribbon = self.ribbon.read().clone();
        session.performance = *self.performance.read();
        session.phones_paused = *self.phones_paused.read();
        session.tables = self.drawing.lock().len();
        let relay = self.relay_join.read().clone();
        if let Some(base) = relay.or_else(|| self.bridge_join.read().clone()) {
            session.join_url = Some(format!("{}/phone?c={}", base.trim_end_matches('/'), session.code));
        }
        session
    }

    /// The join page and PeerJS options for the WebRTC bridge (#275), or None when it is off.
    pub fn join_page(&self) -> Option<(String, Option<Value>)> {
        self.options.join_page.clone().map(|page| (page, self.options.peer_options.clone()))
    }

    /// Phones connected now, for the operator window (#394).
    pub fn phones_connected(&self) -> usize {
        self.inner.lock().seats.iter().filter(|s| s.participant.connected).count()
    }

    /// Admits a surface. Phones need the session code and a seat: their own, if `resume`
    /// names one that is still held, otherwise a free one.
    pub fn join(&self, role: Role, code: Option<&str>, resume: Option<&str>) -> Result<Joined, String> {
        self.join_at(role, code, resume, Instant::now())
    }

    pub(super) fn join_at(&self, role: Role, code: Option<&str>, resume: Option<&str>, now: Instant) -> Result<Joined, String> {
        let mut inner = self.inner.lock();
        if role == Role::Guide {
            // The guide's phone (#98) has its own code, which only the operator's screens are told.
            if code != Some(self.guide_code.as_str()) {
                return Err("wrong guide code".into());
            }
            let surface = inner.next_surface;
            inner.next_surface += 1;
            return Ok(Joined { surface, kick: None });
        }
        if role != Role::Phone {
            let surface = inner.next_surface;
            inner.next_surface += 1;
            if matches!(role, Role::Table | Role::Dev) {
                self.drawing.lock().push(surface);
                self.emit("session.changed", json!({ "session": self.session() }));
            }
            if role == Role::Tv {
                // A controller that just opened gets the whole spell before the table goes home.
                self.controllers.lock().push(surface);
                *self.last_input.lock() = now;
            }
            return Ok(Joined { surface, kick: None });
        }
        if code != Some(self.session.code.as_str()) {
            return Err("wrong session code".into());
        }
        // Holds that ran out are free, whether or not their timer has fired yet.
        let hold = self.options.resume_hold;
        inner.seats.retain(|s| s.held_since.is_none_or(|since| now.duration_since(since) < hold));

        let surface = inner.next_surface;
        let kick = Arc::new(Notify::new());
        if let Some(seat) = resume.and_then(|token| inner.seats.iter_mut().find(|s| s.token == token)) {
            // The phone is back, or it reloaded before the host noticed the old connection die.
            if seat.participant.connected {
                seat.kick.notify_one();
            }
            seat.participant.surface = surface;
            seat.participant.connected = true;
            seat.held_since = None;
            seat.epoch += 1;
            seat.kick = kick.clone();
        } else {
            let limit = self.options.max_phones;
            let Some(slot) = (0..limit).find(|slot| inner.seats.iter().all(|s| s.participant.slot != *slot)) else {
                // Every seat is taken: the phone may still look around (#462), in no seat.
                inner.watching.push(Watcher { surface, allowance: self.options.phone_requests_per_second as f64, refilled: now });
                inner.next_surface += 1;
                return Ok(Joined { surface, kick: None });
            };
            // An animal nobody here has, and a mood, picked at random.
            let free: Vec<&'static str> =
                AVATARS.iter().copied().filter(|a| inner.seats.iter().all(|s| s.participant.avatar != *a)).collect();
            let avatar = free[random_u64() as usize % free.len().max(1)];
            let mood = MOODS[random_u64() as usize % MOODS.len()];
            inner.seats.push(Seat {
                participant: Participant {
                    surface,
                    slot,
                    colour: SLOT_COLOURS[slot % SLOT_COLOURS.len()],
                    connected: true,
                    avatar,
                    mood,
                    name: None,
                },
                token: format!("{:016x}{:016x}", random_u64(), random_u64()),
                epoch: 0,
                held_since: None,
                kick: kick.clone(),
                allowance: self.options.phone_requests_per_second as f64,
                refilled: now,
            });
        }
        inner.next_surface += 1;
        self.note_phone(&inner.seats, surface, "joined", json!({}));
        self.emit("state.participants", json!({ "participants": inner.participants() }));
        Ok(Joined { surface, kick: Some(kick) })
    }

    /// A surface's connection ended. For a phone the seat is held; call `expire` with the
    /// returned hold after `SessionOptions::resume_hold`.
    pub fn leave(&self, surface: u64) -> Option<Hold> {
        self.leave_at(surface, Instant::now())
    }

    pub(super) fn leave_at(&self, surface: u64, now: Instant) -> Option<Hold> {
        let mut inner = self.inner.lock();
        let drew = {
            let mut drawing = self.drawing.lock();
            let before = drawing.len();
            drawing.retain(|s| *s != surface);
            drawing.len() != before
        };
        if drew {
            self.emit("session.changed", json!({ "session": self.session() }));
        }
        self.controllers.lock().retain(|s| *s != surface);
        inner.watching.retain(|w| w.surface != surface);
        // A seat that was taken over belongs to another surface by now, so this finds nothing.
        let seat = inner.seats.iter_mut().find(|s| s.participant.surface == surface && s.participant.connected)?;
        seat.participant.connected = false;
        seat.held_since = Some(now);
        seat.epoch += 1;
        let hold = Hold { slot: seat.participant.slot, epoch: seat.epoch };
        self.note_phone(&inner.seats, surface, "left", json!({}));
        self.emit("state.participants", json!({ "participants": inner.participants() }));
        Some(hold)
    }

    /// Releases a held seat, unless its phone came back in the meantime.
    pub fn expire(&self, hold: Hold) {
        let mut inner = self.inner.lock();
        let before = inner.seats.len();
        inner.seats.retain(|s| !(s.participant.slot == hold.slot && s.epoch == hold.epoch && !s.participant.connected));
        if inner.seats.len() != before {
            self.emit("state.participants", json!({ "participants": inner.participants() }));
        }
    }

    /// Notes what a phone did in the session log (#335): when, which phone, what. The operator
    /// downloads it from the Developer window. The oldest entries go beyond 2000.
    pub(super) fn note_phone(&self, seats: &[Seat], surface: u64, what: &str, detail: Value) {
        let Some(seat) = seats.iter().find(|s| s.participant.surface == surface) else { return };
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
        let p = &seat.participant;
        let mut entry = json!({ "at": at, "slot": p.slot, "avatar": p.avatar, "name": p.name, "what": what });
        if let (Value::Object(entry), Value::Object(detail)) = (&mut entry, detail) {
            entry.extend(detail);
        }
        let mut log = self.phone_log.lock();
        // A dragged slider is one entry, its last value: the same phone setting the same controls again.
        if let Some(last) = log.back_mut() {
            let same = |e: &Value| {
                (
                    e["slot"].clone(),
                    e["what"].clone(),
                    e["layer"].clone(),
                    e["params"].as_object().map(|p| p.keys().cloned().collect::<Vec<_>>()),
                )
            };
            if what == "set" && same(last) == same(&entry) {
                *last = entry;
                return;
            }
        }
        log.push_back(entry);
        while log.len() > 2000 {
            log.pop_front();
        }
    }

    /// Whether the operator let this phone go (#335), so its connection can say so. Asked once.
    pub fn was_released(&self, surface: u64) -> bool {
        let mut released = self.released.lock();
        let before = released.len();
        released.retain(|s| *s != surface);
        released.len() != before
    }

    pub fn resume_hold(&self) -> Duration {
        self.options.resume_hold
    }

    /// Whether a phone may make another request now. Each phone has an allowance that
    /// refills at the session's rate and holds at most one second's worth.
    pub fn allow(&self, surface: u64) -> bool {
        self.allow_at(surface, Instant::now())
    }

    pub(super) fn allow_at(&self, surface: u64, now: Instant) -> bool {
        let rate = self.options.phone_requests_per_second as f64;
        let mut inner = self.inner.lock();
        let inner = &mut *inner;
        let (allowance, refilled) = match inner.seats.iter_mut().find(|s| s.participant.surface == surface) {
            Some(seat) => (&mut seat.allowance, &mut seat.refilled),
            None => match inner.watching.iter_mut().find(|w| w.surface == surface) {
                Some(watcher) => (&mut watcher.allowance, &mut watcher.refilled),
                None => return false,
            },
        };
        *allowance = (*allowance + now.duration_since(*refilled).as_secs_f64() * rate).min(rate);
        *refilled = now;
        if *allowance < 1.0 {
            return false;
        }
        *allowance -= 1.0;
        true
    }

    /// The `welcome` message for a surface. A phone's carries the token that resumes its seat.
    pub fn welcome(&self, surface: u64) -> Value {
        let inner = self.inner.lock();
        let mut welcome = json!({
            "t": "welcome",
            "surface": surface,
            "state": {
                "protocol": PROTOCOL,
                "session": self.session(),
                "site": &*self.info.read(),
                "scene": inner.order(),
                "layers": inner.layers(),
                "participants": inner.participants(),
            },
            "manifests": self.catalog().iter().map(|d| &d.manifest).collect::<Vec<_>>(),
            // The host's clock, so a view can tell where a play head is now (#373).
            "time": host_millis(),
        });
        if let Some(seat) = inner.seats.iter().find(|s| s.participant.surface == surface) {
            welcome["resume"] = json!(seat.token);
        }
        if inner.watching.iter().any(|w| w.surface == surface) {
            welcome["watching"] = json!(true);
        }
        welcome
    }

    /// The phone in this surface as the pages show it: colour, animal, fun name parts and name.
    pub fn participant_of(&self, surface: u64) -> Option<Value> {
        let inner = self.inner.lock();
        let seat = inner.seats.iter().find(|s| s.participant.surface == surface)?;
        let p = &seat.participant;
        Some(json!({ "colour": p.colour, "avatar": p.avatar, "mood": p.mood, "name": p.name }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::test_support::*;

    #[test]
    fn the_guide_drives_a_tour_with_its_own_code_and_reads_its_notes() {
        let hub = scratch_hub("guide");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        let guide = dev("session.guide", json!({})).unwrap();
        let code = guide["code"].as_str().unwrap().to_string();
        assert_eq!(code.len(), 6);
        assert!(hub.request(Role::Phone, 0, "session.guide", &json!({})).is_err(), "phones are never told it");
        assert!(hub.request(Role::Guide, 0, "session.guide", &json!({})).is_err());

        // The guide joins with its code, not the visitors' one, and takes no seat.
        let phones = hub.session().code;
        assert!(hub.join(Role::Guide, Some(&phones), None).is_err());
        let joined = hub.join(Role::Guide, Some(&code), None).unwrap();
        assert!(joined.kick.is_none());
        assert_eq!(hub.welcome(0)["state"]["participants"].as_array().unwrap().len(), 0);

        // A two-step tour with notes; the notes are kept in site.json.
        let steps = json!({ "mode": "manual", "sequence": [
            { "layer": "sunlight", "params": { "hour": 9 }, "title": "Morning", "notes": "Point at the long shadows on the square." },
            { "layer": "wind", "title": "Wind" }
        ] });
        dev("scene.set", json!({ "layer": "slideshow", "steps": steps })).unwrap();
        let saved = Site::load(&hub.site.dir).unwrap().manifest;
        assert!(serde_json::to_string(&saved.layers).unwrap().contains("long shadows"));

        // The guide opens the tour, steps through it and ends it; it cannot edit the table.
        let guide = |method: &str, p: Value| hub.request(Role::Guide, joined.surface, method, &p);
        guide("layer.activate", json!({ "layer": "slideshow", "active": true })).unwrap();
        assert_eq!(layer(&hub, "slideshow")["steps"]["sequence"][0]["notes"], "Point at the long shadows on the square.");
        guide("layer.step", json!({ "layer": "slideshow", "to": "next" })).unwrap();
        assert_eq!(layer(&hub, "wind")["active"], true);
        guide("layers.reset", json!({})).unwrap();
        assert_eq!(layer(&hub, "slideshow")["active"], false);
        assert!(guide("scene.set", json!({ "layer": "slideshow", "steps": { "sequence": [] } })).is_err());
        assert!(guide("site.sources", json!({})).is_err());
    }

    #[test]
    fn the_session_counts_the_views_that_draw_the_table() {
        let hub = scratch_hub("tables");
        assert_eq!(hub.session().tables, 0);
        let tv = hub.join(Role::Tv, None, None).unwrap();
        assert_eq!(hub.session().tables, 0, "a controller does not run the layers");
        let table = hub.join(Role::Table, None, None).unwrap();
        assert_eq!(hub.session().tables, 1);
        hub.leave(table.surface);
        hub.leave(tv.surface);
        assert_eq!(hub.session().tables, 0);
    }

    #[test]
    fn the_operator_pauses_lets_go_and_logs_the_phones() {
        let hub = scratch_hub("phones-operator");
        let code = hub.session().code;
        let me = hub.join(Role::Phone, Some(&code), None).unwrap();
        let phone = |method: &str, p: Value| hub.request(Role::Phone, me.surface, method, &p);
        let tv = |method: &str, p: Value| hub.request(Role::Tv, 0, method, &p);
        phone("layer.activate", json!({ "layer": "wind", "active": true })).unwrap();
        // Paused (#335): a phone looks but changes nothing, and only the operator pauses.
        assert!(phone("phones.pause", json!({ "paused": true })).is_err());
        tv("phones.pause", json!({ "paused": true })).unwrap();
        assert!(hub.session().phones_paused);
        let refused = phone("layer.set", json!({ "layer": "wind", "params": { "style": "particles" } })).unwrap_err();
        assert!(refused.contains("paused"), "{refused}");
        phone("participant.profile", json!({ "name": "Ada" })).unwrap();
        tv("phones.pause", json!({ "paused": false })).unwrap();
        // A dragged slider is one entry in the log, its last value.
        for style in ["ribbons", "map", "particles"] {
            phone("layer.set", json!({ "layer": "wind", "params": { "style": style } })).unwrap();
        }
        let log = tv("phones.log", json!({})).unwrap()["log"].as_array().unwrap().clone();
        let what: Vec<&str> = log.iter().map(|e| e["what"].as_str().unwrap()).collect();
        assert_eq!(what, ["joined", "turned on", "set"]);
        assert_eq!(log[2]["params"]["style"], "particles");
        assert_eq!(log[2]["name"], "Ada");
        // Let go: the seat is free at once and the connection is told why.
        assert!(tv("phones.release", json!({ "slot": 5 })).is_err(), "nobody in that slot");
        tv("phones.release", json!({ "slot": 0 })).unwrap();
        assert!(hub.welcome(0)["state"]["participants"].as_array().unwrap().is_empty());
        assert!(hub.was_released(me.surface));
        assert!(!hub.was_released(me.surface), "asked once");
    }

    #[test]
    fn the_join_url_carries_the_code() {
        let hub = hub(SessionOptions::default());
        let code = hub.session().code.clone();
        assert_eq!(code.len(), 4);
        assert_eq!(hub.session().join_url.as_deref(), Some(format!("http://10.0.0.5:4170/phone?c={code}").as_str()));
    }

    #[test]
    fn every_phone_is_a_different_animal_and_may_rename_itself() {
        let hub = hub(SessionOptions::default());
        let code = hub.session().code.clone();
        let phones: Vec<u64> = (0..8).map(|_| hub.join(Role::Phone, Some(&code), None).unwrap().surface).collect();
        let people = hub.inner.lock().participants();
        let animals: std::collections::HashSet<_> = people.iter().map(|p| p.avatar).collect();
        assert_eq!(animals.len(), 8, "no two phones share an animal");
        assert!(people.iter().all(|p| MOODS.contains(&p.mood) && p.name.is_none()));

        let me = phones[0];
        let set = |p: Value| hub.request(Role::Phone, me, "participant.profile", &p);
        let back = set(json!({ "avatar": "whale", "name": "  Ada\n  Lovelace " })).unwrap();
        assert_eq!((back["participant"]["avatar"].clone(), back["participant"]["name"].clone()), (json!("whale"), json!("Ada Lovelace")));
        assert!(set(json!({ "avatar": "dragon" })).is_err(), "only the animals offered");
        assert!(set(json!({ "name": "x".repeat(33) })).is_err(), "names are short");
        set(json!({ "name": "" })).unwrap();
        assert_eq!(hub.inner.lock().participants()[0].name, None, "an empty name brings the fun name back");
        assert!(hub.request(Role::Tv, 0, "participant.profile", &json!({ "name": "TV" })).is_err());
    }

    #[test]
    fn a_dropped_phone_gets_its_seat_back_within_the_hold() {
        let hub = hub(SessionOptions::default());
        let code = hub.session().code.clone();
        let t0 = Instant::now();
        let first = hub.join_at(Role::Phone, Some(&code), None, t0).unwrap();
        let second = hub.join_at(Role::Phone, Some(&code), None, t0).unwrap();
        let ticket = token(&hub, first.surface);
        assert_ne!(ticket, token(&hub, second.surface));
        assert!(hub.welcome(999)["resume"].is_null(), "only the seat's own surface is told the token");

        // The seat stays in the list, marked as away, and nobody else is given it.
        let hold = hub.leave_at(first.surface, t0).unwrap();
        assert_eq!(slots(&hub), [(0, false), (1, true)]);
        let third = hub.join_at(Role::Phone, Some(&code), None, t0 + Duration::from_secs(1)).unwrap();
        assert_eq!(slots(&hub), [(0, false), (1, true), (2, true)]);

        // Back after 59 s: same slot, new surface, and the old hold no longer releases it.
        let back = hub.join_at(Role::Phone, Some(&code), Some(&ticket), t0 + Duration::from_secs(59)).unwrap();
        assert_ne!(back.surface, first.surface);
        assert_eq!(slots(&hub), [(0, true), (1, true), (2, true)]);
        assert_eq!(token(&hub, back.surface), ticket);
        hub.expire(hold);
        assert_eq!(slots(&hub), [(0, true), (1, true), (2, true)]);
        // The connection that was replaced leaving later changes nothing either.
        assert!(hub.leave_at(first.surface, t0).is_none());
        let _ = third;
    }

    #[test]
    fn a_seat_is_released_when_the_hold_runs_out() {
        let hub = hub(SessionOptions { max_phones: 1, ..SessionOptions::default() });
        let code = hub.session().code.clone();
        let t0 = Instant::now();
        let first = hub.join_at(Role::Phone, Some(&code), None, t0).unwrap();
        let ticket = token(&hub, first.surface);
        let hold = hub.leave_at(first.surface, t0).unwrap();

        // While it is held the session is full for everyone else: a new phone only watches (#462).
        let watcher = hub.join_at(Role::Phone, Some(&code), None, t0 + Duration::from_secs(30)).unwrap();
        assert!(watcher.kick.is_none());
        assert_eq!(hub.welcome(watcher.surface)["watching"], json!(true));
        assert!(hub
            .request(Role::Phone, watcher.surface, "layer.set", &json!({ "layer": "sunlight", "params": {} }))
            .unwrap_err()
            .contains("every seat"));
        hub.leave(watcher.surface);
        // After 60 s the seat is free even if the timer has not fired, and the old token is just a new join.
        let late = hub.join_at(Role::Phone, Some(&code), Some(&ticket), t0 + Duration::from_secs(61)).unwrap();
        assert_ne!(token(&hub, late.surface), ticket);
        hub.expire(hold);
        assert_eq!(slots(&hub), [(0, true)]);

        // The timer releases a seat nobody came back to.
        let hold = hub.leave_at(late.surface, t0).unwrap();
        hub.expire(hold);
        assert_eq!(slots(&hub), []);
    }

    #[test]
    fn a_second_connection_with_the_token_takes_the_seat_over() {
        let hub = hub(SessionOptions::default());
        let code = hub.session().code.clone();
        let first = hub.join(Role::Phone, Some(&code), None).unwrap();
        let ticket = token(&hub, first.surface);
        let second = hub.join(Role::Phone, Some(&code), Some(&ticket)).unwrap();
        assert_eq!(slots(&hub), [(0, true)]);
        // The first connection is told to go, and no longer counts as a phone.
        assert!(tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(async { tokio::time::timeout(Duration::from_secs(1), first.kick.unwrap().notified()).await.is_ok() }));
        assert!(!hub.allow(first.surface));
        assert!(hub.allow(second.surface));
        // A token is no use without the code.
        assert!(hub.join(Role::Phone, None, Some(&ticket)).is_err());
    }

    #[test]
    fn phones_get_twenty_requests_a_second() {
        let hub = hub(SessionOptions::default());
        let code = hub.session().code.clone();
        let t0 = Instant::now();
        let phone = hub.join_at(Role::Phone, Some(&code), None, t0).unwrap().surface;
        let other = hub.join_at(Role::Phone, Some(&code), None, t0).unwrap().surface;
        let burst = (0..50).filter(|_| hub.allow_at(phone, t0)).count();
        assert_eq!(burst, 20);
        // One phone flooding does not use up another's allowance.
        assert!(hub.allow_at(other, t0));
        // Half a second later ten more are allowed, and never more than a second's worth is saved up.
        let later = (0..50).filter(|_| hub.allow_at(phone, t0 + Duration::from_millis(500))).count();
        assert_eq!(later, 10);
        let saved = (0..50).filter(|_| hub.allow_at(phone, t0 + Duration::from_secs(60))).count();
        assert_eq!(saved, 20);
    }
}
