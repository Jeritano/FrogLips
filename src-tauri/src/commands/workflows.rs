//! Workflows (agent orchestration) command layer — persistence + run records.

use super::{blocking, MAX_TITLE_LEN};
use crate::workflows::{self, MAX_GRAPH_BYTES};

/// Hard cap on a workflow run's `results_json` payload.
const MAX_RESULTS_BYTES: usize = MAX_GRAPH_BYTES;

#[tauri::command]
pub async fn workflow_list() -> Result<Vec<workflows::Workflow>, String> {
    blocking(workflows::list_workflows).await
}

#[tauri::command]
pub async fn workflow_get(id: i64) -> Result<workflows::Workflow, String> {
    blocking(move || workflows::get_workflow(id)).await
}

/// Insert (when `id` is `null`) or update a workflow. `graph_json` must parse
/// as a `{ cards, edges }` object of the shared shape; malformed input is
/// rejected. Returns the workflow id.
#[tauri::command]
pub async fn workflow_save(
    id: Option<i64>,
    name: String,
    graph_json: String,
) -> Result<i64, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("name must not be empty".into());
    }
    if trimmed.len() > MAX_TITLE_LEN {
        return Err(format!("name exceeds {MAX_TITLE_LEN} chars"));
    }
    if graph_json.len() > MAX_GRAPH_BYTES {
        return Err(format!("graph_json exceeds {MAX_GRAPH_BYTES} bytes"));
    }
    let name = trimmed.to_string();
    blocking(move || workflows::save_workflow(id, &name, &graph_json)).await
}

#[tauri::command]
pub async fn workflow_delete(id: i64) -> Result<(), String> {
    blocking(move || workflows::delete_workflow(id)).await
}

/// Record a workflow run. Returns the new run id.
#[tauri::command]
pub async fn workflow_run_record(
    workflow_id: i64,
    status: String,
    results_json: String,
) -> Result<i64, String> {
    if status.trim().is_empty() {
        return Err("status must not be empty".into());
    }
    if results_json.len() > MAX_RESULTS_BYTES {
        return Err(format!("results_json exceeds {MAX_RESULTS_BYTES} bytes"));
    }
    blocking(move || workflows::record_run(workflow_id, &status, &results_json)).await
}

#[tauri::command]
pub async fn workflow_runs_list(workflow_id: i64) -> Result<Vec<workflows::WorkflowRun>, String> {
    blocking(move || workflows::list_runs(workflow_id)).await
}
