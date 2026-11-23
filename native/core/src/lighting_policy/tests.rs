use super::*;
use crate::recovery::DeviceIdentity;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Oracle {
    models: Vec<Model>,
    colors: Vec<[[u8; 3]; 3]>,
    targets: Vec<ColorTarget>,
    palettes: Vec<PaletteVector>,
    states: Vec<StateVector>,
}
#[derive(Deserialize)]
struct ColorTarget {
    target: [u8; 3],
    input: Option<[u8; 3]>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaletteVector {
    model_id: String,
    input: Vec<u8>,
    rendered: Vec<u8>,
    lower: Vec<u8>,
    upper: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateVector {
    model_id: String,
    target: Vec<u8>,
    observed: Vec<u8>,
    offset: usize,
    payload: Vec<u8>,
    owned_matches: bool,
    archive_required: bool,
}
fn oracle() -> Oracle {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/windows-lighting-recovery.json"
    )))
    .unwrap()
}
fn binding(model: &Model) -> Binding {
    Binding {
        model_id: model.id.clone(),
        vendor_id: model.vendor_id,
        product_id: model.product_ids[0],
        firmware_version: model.qualified_firmware.clone(),
        lighting_profile: 1,
        identity: DeviceIdentity::Serial("policy-fixture-0".into()),
    }
}
fn state(model: &Model) -> Vec<u8> {
    let mut state = vec![
        21, 100, 2, 0, 1, 3, 255, 255, 255, 2, 50, 2, 1, 0, 255, 0, 0,
    ];
    if model.lighting_state_length == 22 {
        state.extend([3, 24, 48, 96, 94]);
    }
    state
}
fn full(model: &Model, main: &[u8]) -> Vec<u8> {
    assert_eq!(main.len(), model.key_count * 3);
    let mut all = main.to_vec();
    all.extend(vec![0; model.side_count * 3]);
    all
}
fn code<T>(result: Result<T>) -> String {
    match result {
        Ok(_) => panic!("expected rejection"),
        Err(e) => e.code,
    }
}

#[test]
fn model_loading_rejects_a_recovery_policy_that_does_not_match_the_qualified_schema() {
    let fixture = oracle();
    let valid = serde_json::to_value(&fixture.models).unwrap();
    assert_eq!(crate::models(&valid.to_string()).unwrap().len(), 8);
    for (field, value) in [
        ("qualifiedFirmware", "1.0.24.6"),
        ("lightingRecoveryPolicy", "s4-qualified-17"),
        ("lightingRecoveryPolicy", "unknown-policy"),
    ] {
        let mut changed = valid.clone();
        changed[0][field] = value.into();
        assert_eq!(code(crate::models(&changed.to_string())), "INVALID_MODELS");
    }
}

#[test]
fn swift_float32_readback_and_exact_inverse_match_the_complete_fixture_grid() {
    let fixture = oracle();
    assert_eq!(fixture.colors.len(), 4096);
    for [input, expected, encoded] in fixture.colors {
        assert_eq!(main_color_readback(input), expected, "input {input:?}");
        assert_eq!(
            exact_main_color_input(expected).unwrap(),
            encoded,
            "target {expected:?}"
        );
        assert_eq!(main_color_readback(encoded), expected);
    }
    for row in fixture.targets {
        match row.input {
            Some(input) => assert_eq!(exact_main_color_input(row.target).unwrap(), input),
            None => assert_eq!(
                code(exact_main_color_input(row.target)),
                "RESTORE_COLOR_UNREPRESENTABLE"
            ),
        }
    }
}

#[test]
fn all_eight_palette_renderers_and_preimage_bounds_match_swift() {
    let fixture = oracle();
    assert_eq!(fixture.palettes.len(), 8);
    for row in fixture.palettes {
        let model = fixture
            .models
            .iter()
            .find(|m| m.id == row.model_id)
            .unwrap();
        assert_eq!(
            rendered_palette(model, &model.qualified_firmware, &row.input).unwrap(),
            row.rendered
        );
        let proof = ReconstructedPalette::capture(
            model,
            &binding(model),
            &state(model),
            &full(model, &row.rendered),
        )
        .unwrap();
        assert_eq!(proof.colors(), row.lower);
        assert_eq!(
            inverse(model.lighting_recovery_policy, &row.rendered, true).unwrap(),
            row.upper
        );
        assert_eq!(
            rendered_palette(model, &model.qualified_firmware, proof.colors()).unwrap(),
            row.rendered
        );
    }
    // Exhaust the byte domain, including the AIR final LED's two scaled channels.
    let model = &fixture.models[0];
    for value in 0..=255u8 {
        let input = vec![value; model.key_count * 3];
        let rendered = rendered_palette(model, &model.qualified_firmware, &input).unwrap();
        for high in [false, true] {
            let candidate = inverse(model.lighting_recovery_policy, &rendered, high).unwrap();
            assert_eq!(
                rendered_palette(model, &model.qualified_firmware, &candidate).unwrap(),
                rendered
            );
        }
    }
}

#[test]
fn settings_payloads_and_every_owned_field_match_the_real_swift_model_rules() {
    let fixture = oracle();
    assert_eq!(fixture.states.len(), 141);
    for row in fixture.states {
        let model = fixture
            .models
            .iter()
            .find(|m| m.id == row.model_id)
            .unwrap();
        let plan =
            state_write_plan(model, &model.qualified_firmware, &row.target, &row.observed).unwrap();
        assert_eq!(plan.address, 0);
        assert_eq!(
            plan.payload, row.payload,
            "{} offset {}",
            model.id, row.offset
        );
        assert_eq!(plan.payload.len(), 17);
        assert_eq!(
            owned_state_matches(model, &model.qualified_firmware, &row.target, &row.observed)
                .unwrap(),
            row.owned_matches,
            "{} offset {}",
            model.id,
            row.offset
        );
        assert_eq!(
            preset_fields_differ(model, &model.qualified_firmware, &row.target, &row.observed)
                .unwrap(),
            row.archive_required
        );
    }
}

#[test]
fn only_full_brightness_qualified_custom_observations_can_construct_palette_proofs() {
    let fixture = oracle();
    let model = &fixture.models[0];
    let current = binding(model);
    let good = state(model);
    let rendered = vec![0; (model.key_count + model.side_count) * 3];
    for (offset, value) in [(0, 2), (1, 99), (4, 0), (6, 254)] {
        let mut dim = good.clone();
        dim[offset] = value;
        assert_eq!(
            code(ReconstructedPalette::capture(
                model, &current, &dim, &rendered
            )),
            "PALETTE_NOT_OBSERVABLE"
        );
    }
    assert_eq!(
        code(ReconstructedPalette::capture(
            model,
            &current,
            &good,
            &rendered[..3]
        )),
        "INVALID_PALETTE"
    );
    let mut impossible = rendered.clone();
    impossible[0] = 201;
    assert_eq!(
        code(ReconstructedPalette::capture(
            model,
            &current,
            &good,
            &impossible
        )),
        "CUSTOM_BACKUP_LOSSY"
    );
    let mut wrong = current;
    wrong.firmware_version = "2.0.0.8".into();
    assert!(ReconstructedPalette::capture(model, &wrong, &good, &rendered).is_err());
    assert_eq!(
        code(rendered_palette(model, "2.0.0.8", &vec![0; 252])),
        "RECOVERY_POLICY_UNVERIFIED"
    );
    let mut stale = model.clone();
    stale.qualified_firmware = "1.0.24.6".into();
    assert_eq!(
        code(rendered_palette(&stale, "1.0.24.6", &vec![0; 252])),
        "RECOVERY_POLICY_UNVERIFIED"
    );
}

#[test]
fn preset_drift_is_preserved_and_requires_history_even_when_it_happens_during_restore() {
    let fixture = oracle();
    let model = &fixture.models[0];
    let current = binding(model);
    let mut original = state(model);
    original[0] = 2;
    original[1] = 75;
    original[4] = 0;
    original[6..9].copy_from_slice(&[64, 0, 14]);
    let saved = Baseline {
        binding: current.clone(),
        state: original.clone(),
        rendered_colors: vec![7; 312],
    };
    let mut live = original.clone();
    live[1] = 100;
    live[5] = 4;
    live[17] = 4;
    live[21] = 93;
    let plan = plan_restore(model, &saved, &current, &live, None).unwrap();
    assert!(plan.archive_required);
    assert_eq!(plan.settings.as_ref().unwrap().payload[5], 4);
    assert_eq!(plan.settings.as_ref().unwrap().payload.len(), 17);
    assert_eq!(
        main_color_readback(plan.settings.unwrap().payload[6..9].try_into().unwrap()),
        [64, 0, 14]
    );
    let plan = plan_restore(model, &saved, &current, &original, None).unwrap();
    assert!(!plan.archive_required);
    assert!(plan.settings.is_none());
    let mut after = original.clone();
    after[17] = 4;
    let assessment = assess_restore(model, &plan, &current, &after, None, None).unwrap();
    assert!(assessment.archive_required);
    after[1] = 74;
    assert_eq!(
        code(assess_restore(model, &plan, &current, &after, None, None)),
        "RESTORE_STATE_MISMATCH"
    );
}

#[test]
fn master_off_restoration_requires_every_led_black_and_never_claims_the_switch_changed() {
    let fixture = oracle();
    let model = &fixture.models[0];
    let current = binding(model);
    let mut off = state(model);
    off[0] = 0;
    off[1] = 0;
    off[10] = 0;
    let saved = Baseline {
        binding: current.clone(),
        state: off.clone(),
        rendered_colors: vec![0; 312],
    };
    let unchanged = plan_restore(model, &saved, &current, &off, None).unwrap();
    assert!(unchanged.settings.is_none());
    assert_eq!(
        code(assess_restore(
            model, &unchanged, &current, &off, None, None
        )),
        "RESTORE_COLOR_MISMATCH"
    );
    let mut live = off.clone();
    live[0] = 21;
    live[1] = 100;
    let plan = plan_restore(model, &saved, &current, &live, None).unwrap();
    assert_eq!(plan.settings.as_ref().unwrap().payload[0], 2);
    let mut restored = off;
    restored[0] = 2;
    let mut colors = vec![0; 312];
    colors[311] = 1;
    assert_eq!(
        code(assess_restore(
            model,
            &plan,
            &current,
            &restored,
            Some(&colors),
            None
        )),
        "RESTORE_COLOR_MISMATCH"
    );
    colors[311] = 0;
    let assessment =
        assess_restore(model, &plan, &current, &restored, Some(&colors), None).unwrap();
    assert!(assessment.all_dark_verified);
    assert!(!assessment.custom_colors_verified);
}

#[test]
fn custom_restoration_needs_a_proof_and_independent_original_color_readback() {
    let fixture = oracle();
    let model = &fixture.models[0];
    let current = binding(model);
    let source = rendered_palette(model, &model.qualified_firmware, &vec![120; 252]).unwrap();
    let colors = full(model, &source);
    let original = state(model);
    let saved = Baseline {
        binding: current.clone(),
        state: original.clone(),
        rendered_colors: colors.clone(),
    };
    assert_eq!(
        code(plan_restore(model, &saved, &current, &original, None)),
        "BACKUP_INCOMPLETE"
    );
    let palette = ReconstructedPalette::capture(model, &current, &original, &colors).unwrap();
    let plan = plan_restore(model, &saved, &current, &original, Some(&palette)).unwrap();
    assert!(plan.palette_required);
    assert_eq!(plan.palette_settle_ms, 1150);
    assert!(
        plan.settings.is_some(),
        "palette restoration changes the temporary mode; final state must be reapplied"
    );
    assert_eq!(
        code(assess_restore(
            model, &plan, &current, &original, None, None
        )),
        "PALETTE_VERIFY_REQUIRED"
    );
    let evidence = verify_palette_readback(model, &palette, &current, &original, &colors).unwrap();
    assert_eq!(
        code(assess_restore(
            model,
            &plan,
            &current,
            &original,
            None,
            Some(&evidence)
        )),
        "RESTORE_COLOR_MISMATCH"
    );
    let mut wrong = colors.clone();
    wrong[0] ^= 1;
    assert_eq!(
        code(assess_restore(
            model,
            &plan,
            &current,
            &original,
            Some(&wrong),
            Some(&evidence)
        )),
        "RESTORE_COLOR_MISMATCH"
    );
    assert!(
        assess_restore(
            model,
            &plan,
            &current,
            &original,
            Some(&colors),
            Some(&evidence)
        )
        .unwrap()
        .custom_colors_verified
    );
    let mut switched = current.clone();
    switched.lighting_profile = 0;
    assert_eq!(
        code(plan_restore(
            model,
            &saved,
            &switched,
            &original,
            Some(&palette)
        )),
        "BACKUP_DEVICE_MISMATCH"
    );
    assert_eq!(
        code(assess_restore(
            model,
            &plan,
            &switched,
            &original,
            Some(&colors),
            None
        )),
        "BACKUP_DEVICE_MISMATCH"
    );
}

#[test]
fn stock_effects_cannot_hide_a_failed_palette_restore_behind_a_correct_final_state() {
    let fixture = oracle();
    let model = &fixture.models[0];
    let current = binding(model);
    let custom = state(model);
    let mut stock = custom.clone();
    stock[0] = 2;
    stock[1] = 60;
    let rendered = full(
        model,
        &rendered_palette(model, &model.qualified_firmware, &vec![120; 252]).unwrap(),
    );
    let palette = ReconstructedPalette::capture(model, &current, &custom, &rendered).unwrap();
    let saved = Baseline {
        binding: current.clone(),
        state: stock.clone(),
        rendered_colors: vec![7; 312],
    };
    let plan = plan_restore(model, &saved, &current, &stock, Some(&palette)).unwrap();
    assert_eq!(
        code(assess_restore(model, &plan, &current, &stock, None, None)),
        "PALETTE_VERIFY_REQUIRED"
    );
    let mut wrong = rendered.clone();
    wrong[0] ^= 1;
    assert_eq!(
        code(verify_palette_readback(
            model, &palette, &current, &custom, &wrong
        )),
        "RESTORE_COLOR_MISMATCH"
    );
    let evidence = verify_palette_readback(model, &palette, &current, &custom, &rendered).unwrap();
    let assessment = assess_restore(model, &plan, &current, &stock, None, Some(&evidence)).unwrap();
    assert!(assessment.owned_state_verified && assessment.palette_verified);
    assert!(
        !assessment.custom_colors_verified,
        "a moving stock effect is not compared to an old animation frame"
    );
    let other_colors = full(
        model,
        &rendered_palette(model, &model.qualified_firmware, &vec![130; 252]).unwrap(),
    );
    let other = ReconstructedPalette::capture(model, &current, &custom, &other_colors).unwrap();
    let other_evidence =
        verify_palette_readback(model, &other, &current, &custom, &other_colors).unwrap();
    assert_eq!(
        code(assess_restore(
            model,
            &plan,
            &current,
            &stock,
            None,
            Some(&other_evidence)
        )),
        "RESTORE_COLOR_MISMATCH"
    );
}

#[test]
fn alternate_quantized_candidates_only_change_mismatching_channels_and_retain_full_output() {
    let fixture = oracle();
    let model = &fixture.models[0];
    let current = binding(model);
    let rendered = rendered_palette(model, &model.qualified_firmware, &vec![120; 252]).unwrap();
    let palette =
        ReconstructedPalette::capture(model, &current, &state(model), &full(model, &rendered))
            .unwrap();
    let expected = vec![10; 252];
    let mut actual = expected.clone();
    actual[0] = 9;
    actual[251] = 9;
    let adjusted = palette.dimmed_candidate(model, &actual, &expected).unwrap();
    assert_eq!(&adjusted[1..251], &palette.colors()[1..251]);
    assert_eq!(
        rendered_palette(model, &model.qualified_firmware, &adjusted).unwrap(),
        rendered
    );
    assert!(palette
        .dimmed_candidate(model, &actual[..3], &expected)
        .is_err());
}
