//! Transcript stabilization: confirmed prefix + unstable suffix.
//!
//! Avoids UI flicker by only rewriting the unstable tail when partial hypotheses revise.

#[derive(Debug, Clone, Default)]
pub struct TranscriptStabilizer {
    confirmed: String,
    unstable: String,
    last_full: String,
}

impl TranscriptStabilizer {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Update from a new full hypothesis. Returns (stable_text, active_text) for UI.
    pub fn update(&mut self, hypothesis: &str, is_final: bool) -> (String, String) {
        let h = normalize(hypothesis);
        if h.is_empty() {
            return (self.confirmed.clone(), self.unstable.clone());
        }

        if is_final {
            self.confirmed = join(&self.confirmed, &h);
            self.unstable.clear();
            self.last_full.clear();
            return (self.confirmed.clone(), String::new());
        }

        // Find longest common prefix between last full hypothesis and new one.
        let stable_prefix = common_word_prefix(&self.last_full, &h);
        if !stable_prefix.is_empty() {
            self.confirmed = join(&self.confirmed, &stable_prefix);
        }

        // Unstable suffix = remainder after confirmed words in the new hypothesis.
        let confirmed_words = self.confirmed.split_whitespace().count();
        let all_words: Vec<&str> = h.split_whitespace().collect();
        if all_words.len() > confirmed_words {
            self.unstable = all_words[confirmed_words..].join(" ");
        } else {
            self.unstable = h.clone();
        }

        self.last_full = h;
        (self.confirmed.clone(), self.unstable.clone())
    }

    pub fn finalize(&mut self) -> String {
        let out = join(&self.confirmed, &self.unstable);
        self.reset();
        out
    }
}

fn normalize(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn join(a: &str, b: &str) -> String {
    let a = normalize(a);
    let b = normalize(b);
    if a.is_empty() {
        return b;
    }
    if b.is_empty() {
        return a;
    }
    // Dedupe exact overlap at seam
    let aw: Vec<&str> = a.split_whitespace().collect();
    let bw: Vec<&str> = b.split_whitespace().collect();
    let max = aw.len().min(bw.len());
    let mut k = 0;
    for n in (1..=max).rev() {
        if aw[aw.len() - n..] == bw[..n] {
            k = n;
            break;
        }
    }
    let tail: Vec<&str> = bw[k..].to_vec();
    if tail.is_empty() {
        return a;
    }
    normalize(&format!("{} {}", a, tail.join(" ")))
}

fn common_word_prefix(prev: &str, next: &str) -> String {
    if prev.is_empty() {
        return String::new();
    }
    let p: Vec<&str> = prev.split_whitespace().collect();
    let n: Vec<&str> = next.split_whitespace().collect();
    let mut i = 0;
    while i < p.len() && i < n.len() && p[i] == n[i] {
        i += 1;
    }
    if i == 0 {
        return String::new();
    }
    p[..i].join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stabilizes_prefix() {
        let mut s = TranscriptStabilizer::default();
        let (stable, active) = s.update("I want to schedule a", false);
        assert_eq!(stable, "I want to schedule a");
        assert_eq!(active, "I want to schedule a");

        let (stable, active) = s.update("I want to schedule a meeting tomorrow", false);
        assert_eq!(stable, "I want to schedule a");
        assert!(active.contains("meeting"));
    }
}
