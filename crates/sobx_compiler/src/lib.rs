//! Native sobx analyzer built on oxc, the native half of `@sobx/compiler` (to be distributed as
//! `@sobx/compiler-<platform>`). Exposes `analyze(source, moduleSpecifier?, filename?) -> string`
//! (IR JSON) to Node through napi-rs.

mod analyzer;
mod ir;

use napi_derive::napi;
use oxc_allocator::Allocator;
use oxc_parser::{ParseOptions, Parser};
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;

/// Module whose imports are analyzed when no specifier is given.
pub const DEFAULT_MODULE_SPECIFIER: &str = "@sobx/magic";

/// Analyze `source` and return the IR as a JSON string. Syntax errors are returned as `Err`
/// (like the Babel analyzer, which throws), rather than analyzing a recovered partial AST.
pub fn analyze_to_json(
    source: &str,
    module_specifier: Option<String>,
    filename: Option<String>,
) -> Result<String, String> {
    let allocator = Allocator::default();
    let source_type = SourceType::tsx();
    let parsed = Parser::new(&allocator, source, source_type)
        .with_options(ParseOptions { preserve_parens: false, ..ParseOptions::default() })
        .parse();
    if parsed.fatal_error || parsed.diagnostics.has_errors() {
        let message = parsed
            .diagnostics
            .errors()
            .next()
            .map_or_else(|| "unrecoverable syntax error".to_string(), ToString::to_string);
        return Err(format!("sobx: failed to parse: {message}"));
    }
    let program = allocator.alloc(parsed.program);
    // oxc reports many early errors (which Babel raises while parsing) from the semantic pass.
    let built = SemanticBuilder::new().with_build_nodes(true).with_check_syntax_error(true).build(program);
    if built.diagnostics.has_errors() {
        let message = built.diagnostics.errors().next().map_or_else(String::new, ToString::to_string);
        return Err(format!("sobx: failed to parse: {message}"));
    }
    let semantic = built.semantic;
    let module = analyzer::Analyzer::new(
        source,
        program,
        &semantic,
        module_specifier.unwrap_or_else(|| DEFAULT_MODULE_SPECIFIER.to_string()),
        filename,
    )
    .run();
    serde_json::to_string(&module).map_err(|e| format!("sobx: failed to serialize IR: {e}"))
}

/// Time each phase of [`analyze_to_json`] (parse, semantic, analyze, serialize), in ms.
#[doc(hidden)]
pub fn profile_phases(source: &str) -> [f64; 4] {
    let ms = |t: std::time::Instant| t.elapsed().as_secs_f64() * 1000.0;
    let allocator = Allocator::default();
    let t = std::time::Instant::now();
    let parsed = Parser::new(&allocator, source, SourceType::tsx())
        .with_options(ParseOptions { preserve_parens: false, ..ParseOptions::default() })
        .parse();
    let program = allocator.alloc(parsed.program);
    let parse = ms(t);
    let t = std::time::Instant::now();
    let semantic = SemanticBuilder::new().with_build_nodes(true).build(program).semantic;
    let sem = ms(t);
    let t = std::time::Instant::now();
    let module = analyzer::Analyzer::new(source, program, &semantic, DEFAULT_MODULE_SPECIFIER.into(), None).run();
    let analyze = ms(t);
    let t = std::time::Instant::now();
    let json = serde_json::to_string(&module).expect("IR serializes");
    std::hint::black_box(json);
    [parse, sem, analyze, ms(t)]
}

/// Node entry point: returns the IR as a JSON string (`JSON.parse` it on the JS side).
/// Syntax errors and panics surface as JS exceptions instead of crashing the process.
#[napi(js_name = "analyze", catch_unwind)]
pub fn analyze(
    source: String,
    module_specifier: Option<String>,
    filename: Option<String>,
) -> napi::Result<String> {
    analyze_to_json(&source, module_specifier, filename).map_err(napi::Error::from_reason)
}
