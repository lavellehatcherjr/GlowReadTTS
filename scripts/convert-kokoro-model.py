import os
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

AXIS_FOR = {
    ("Conv", 1): 0,
    ("ConvTranspose", 1): 1,
    ("MatMul", 1): 1,
    ("LSTM", 1): 1,
    ("LSTM", 2): 1,
}
MIN_ELEMENTS = 4096


def consumers(graph):
    cons = {}
    for node in graph.node:
        for k, name in enumerate(node.input):
            cons.setdefault(name, []).append((node, k))
    return cons


def channel_axis(users):
    axes = set()
    for node, k in users:
        key = (node.op_type, k)
        if key in AXIS_FOR:
            axes.add(AXIS_FOR[key])
        elif key == ("Gemm", 1):
            trans_b = next((a.i for a in node.attribute if a.name == "transB"), 0)
            axes.add(0 if trans_b else 1)
        else:
            return None
    if len(axes) != 1:
        return None
    return axes.pop()


def quantize(w, ax):
    moved = np.moveaxis(w, ax, 0).reshape(w.shape[ax], -1)
    amax = np.max(np.abs(moved), axis=1)
    scale = np.where(amax > 0, amax / 127.0, 1.0).astype(np.float32)
    shape = [1] * w.ndim
    shape[ax] = -1
    q = np.clip(np.round(w / scale.reshape(shape)), -127, 127).astype(np.int8)
    return q, scale


def convert(src, dst):
    model = onnx.load(src)
    print("opset", [(o.domain, o.version) for o in model.opset_import])
    cons = consumers(model.graph)
    new_inits = []
    new_nodes = []
    done = 0
    before = 0
    after = 0
    for t in list(model.graph.initializer):
        if t.data_type != TensorProto.FLOAT:
            continue
        users = cons.get(t.name, [])
        if not users:
            continue
        w = numpy_helper.to_array(t)
        if w.size < MIN_ELEMENTS:
            continue
        ax = channel_axis(users)
        if ax is None:
            continue
        q, scale = quantize(w, ax)
        q_name = t.name + "__q"
        s_name = t.name + "__s"
        z_name = t.name + "__z"
        out_name = t.name + "__dq"
        new_inits.append(numpy_helper.from_array(q, q_name))
        new_inits.append(numpy_helper.from_array(scale, s_name))
        new_inits.append(numpy_helper.from_array(np.zeros(w.shape[ax], np.int8), z_name))
        new_nodes.append(
            helper.make_node(
                "DequantizeLinear",
                [q_name, s_name, z_name],
                [out_name],
                axis=ax,
                name=t.name + "__dqnode",
            )
        )
        for node, k in users:
            node.input[k] = out_name
        model.graph.initializer.remove(t)
        before += w.nbytes
        after += q.nbytes + scale.nbytes
        done += 1
    model.graph.initializer.extend(new_inits)
    for node in reversed(new_nodes):
        model.graph.node.insert(0, node)
    onnx.checker.check_model(model)
    onnx.save(model, dst)
    print(
        "converted", done, "tensors",
        round(before / 1e6, 1), "MB ->", round(after / 1e6, 1), "MB;",
        "file", round(os.path.getsize(dst) / 1e6, 1), "MB",
    )


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: python3 scripts/convert-kokoro-model.py SOURCE DESTINATION")
    convert(sys.argv[1], sys.argv[2])


if __name__ == "__main__":
    main()
