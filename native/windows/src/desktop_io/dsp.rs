//! PCM is consumed in this process; only RMS and eight band levels are emitted.
use std::collections::VecDeque;
const N: usize = 2048;
#[derive(Default)]
pub struct Analyzer {
    samples: VecDeque<f64>,
}
impl Analyzer {
    pub fn push(&mut self, sample: f64) {
        self.samples.push_back(if sample.is_finite() {
            sample.clamp(-1.0, 1.0)
        } else {
            0.0
        });
        if self.samples.len() > N {
            self.samples.pop_front();
        }
    }
    pub fn features(&self, rate: u32) -> Option<(f64, [f64; 8])> {
        if self.samples.len() != N || !(8000..=192000).contains(&rate) {
            return None;
        }
        let rms = (self.samples.iter().map(|v| v * v).sum::<f64>() / N as f64).sqrt();
        let mut real: Vec<_> = self
            .samples
            .iter()
            .enumerate()
            .map(|(i, v)| v * (0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / N as f64).cos()))
            .collect();
        let mut imag = vec![0.0; N];
        let mut j = 0;
        for i in 1..N {
            let mut bit = N >> 1;
            while j & bit != 0 {
                j ^= bit;
                bit >>= 1;
            }
            j ^= bit;
            if i < j {
                real.swap(i, j);
                imag.swap(i, j);
            }
        }
        let mut len = 2;
        while len <= N {
            let angle = -std::f64::consts::TAU / len as f64;
            for start in (0..N).step_by(len) {
                for k in 0..len / 2 {
                    let a = angle * k as f64;
                    let (s, c) = a.sin_cos();
                    let lo = start + k;
                    let hi = lo + len / 2;
                    let r = real[hi] * c - imag[hi] * s;
                    let im = real[hi] * s + imag[hi] * c;
                    real[hi] = real[lo] - r;
                    imag[hi] = imag[lo] - im;
                    real[lo] += r;
                    imag[lo] += im;
                }
            }
            len *= 2;
        }
        let edges = [
            40.0, 80.0, 160.0, 320.0, 640.0, 1280.0, 2560.0, 5120.0, 12000.0,
        ];
        let bands = std::array::from_fn(|b| {
            let lo = (edges[b] * N as f64 / rate as f64).ceil().max(1.0) as usize;
            let hi = ((edges[b + 1] * N as f64 / rate as f64).ceil() as usize)
                .max(lo + 1)
                .min(N / 2);
            if lo >= hi {
                return 0.0;
            }
            (real[lo..hi]
                .iter()
                .zip(&imag[lo..hi])
                .map(|(r, i)| r * r + i * i)
                .sum::<f64>()
                .sqrt()
                * 2.0
                / N as f64)
                .clamp(0.0, 1.0)
        });
        Some((rms.clamp(0.0, 1.0), bands))
    }
}
pub fn pcm(bytes: &[u8], bits: u16, floating: bool) -> Option<f64> {
    let value = match (bits, floating) {
        (16, false) => i16::from_le_bytes(bytes.get(..2)?.try_into().ok()?) as f64 / 32768.0,
        (24, false) => {
            let b = bytes.get(..3)?;
            let v = i32::from_le_bytes([0, b[0], b[1], b[2]]);
            v as f64 / 2147483648.0
        }
        (32, false) => i32::from_le_bytes(bytes.get(..4)?.try_into().ok()?) as f64 / 2147483648.0,
        (32, true) => f32::from_le_bytes(bytes.get(..4)?.try_into().ok()?) as f64,
        (64, true) => f64::from_le_bytes(bytes.get(..8)?.try_into().ok()?),
        _ => return None,
    };
    Some(if value.is_finite() {
        value.clamp(-1.0, 1.0)
    } else {
        0.0
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn silence_and_nonfinite_input_never_escape_the_feature_range() {
        let mut a = Analyzer::default();
        for _ in 0..N {
            a.push(f64::NAN);
        }
        assert_eq!(a.features(48000), Some((0.0, [0.0; 8])));
        assert!(a.features(0).is_none());
        assert_eq!(a.samples.len(), N);
        for _ in 0..N * 4 {
            a.push(2.0);
        }
        assert_eq!(a.samples.len(), N);
        let (r, b) = a.features(44100).unwrap();
        assert_eq!(r, 1.0);
        assert!(b.iter().all(|v| (0.0..=1.0).contains(v)));
    }
    #[test]
    fn known_sines_land_in_the_expected_bands_at_both_sample_rates() {
        for rate in [44100, 48000] {
            for (band, hz) in [60.0, 120.0, 240.0, 480.0, 960.0, 1920.0, 3840.0, 8000.0]
                .iter()
                .enumerate()
            {
                let mut a = Analyzer::default();
                for i in 0..N {
                    a.push(0.5 * (std::f64::consts::TAU * hz * i as f64 / rate as f64).sin());
                }
                let (r, b) = a.features(rate).unwrap();
                assert!((r - 0.35355).abs() < 0.03);
                let peak = b
                    .iter()
                    .enumerate()
                    .max_by(|a, b| a.1.total_cmp(b.1))
                    .unwrap()
                    .0;
                assert_eq!(peak, band);
            }
        }
    }
    #[test]
    fn pcm_decodes_signed_formats_and_rejects_truncation() {
        for (bits, data) in [
            (16, vec![0, 128]),
            (24, vec![0, 0, 128]),
            (32, vec![0, 0, 0, 128]),
        ] {
            assert_eq!(pcm(&data, bits, false), Some(-1.0));
            assert!(pcm(&data[..data.len() - 1], bits, false).is_none());
        }
        assert_eq!(pcm(&f32::NAN.to_le_bytes(), 32, true), Some(0.0));
        assert!(pcm(&[0], 8, false).is_none());
    }
}
