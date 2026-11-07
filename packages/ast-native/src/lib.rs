//! SPIKE: native sobx analyzer built on oxc. Exposes `analyze(source, moduleSpecifier?,
//! filename?) -> string` (IR JSON) to Node through napi-rs.

mod analyzer;
mod ir;

use napi_derive::napi;
use oxc_allocator::Allocator;
use oxc_parser::{ParseOptions, Parser};
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;

/// Analyze `source` and return the IR as a JSON string.
pub fn analyze_to_json(source: &str, module_specifier: Option<String>, filename: Option<String>) -> String {
    let allocator = Allocator::default();
    let source_type = SourceType::tsx();
    let parsed = Parser::new(&allocator, source, source_type)
        .with_options(ParseOptions { preserve_parens: false, ..ParseOptions::default() })
        .parse();
    let program = allocator.alloc(parsed.program);
    let semantic = SemanticBuilder::new().with_build_nodes(true).build(program).semantic;
    let module = analyzer::Analyzer::new(
        source,
        program,
        &semantic,
        module_specifier.unwrap_or_else(|| "sobx".to_string()),
        filename,
    )
    .run();
    serde_json::to_string(&module).expect("IR serializes")
}

/// Node entry point: returns the IR as a JSON string (`JSON.parse` it on the JS side).
#[napi(js_name = "analyze")]
pub fn analyze(source: String, module_specifier: Option<String>, filename: Option<String>) -> String {
    analyze_to_json(&source, module_specifier, filename)
}
