mod models;
mod routes;

use axum::{routing::get, Router};
use crate::routes::orders::{classify, list_orders};
use std::process::Command;

fn app() -> Router {
    Router::new()
        .route("/orders", get(list_orders))
        .route("/orders/:id", get(get_order).post(create_order))
}

fn get_order() -> &'static str {
    let s = r#"fn fake() { if (x) {} }"#;
    let c = '{';
    s
}

fn create_order() -> &'static str {
    classify(1, false)
}

fn sync<'a>(x: &'a str) -> &'a str {
    let _ = Command::new("sh").arg("-c").arg(x).status();
    x
}

fn main() {
    let _ = app();
}
