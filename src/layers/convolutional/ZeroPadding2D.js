import Layer from '../../Layer'
import Tensor from '../../Tensor'
import { webgl2 } from '../../WebGL2'
import ops from 'ndarray-ops'

/**
 * ZeroPadding2D layer class
 */
export default class ZeroPadding2D extends Layer {
  /**
   * Creates a ZeroPadding2D layer
   *
   * @param {Object} [attrs] - layer config attributes
   * @param {number|number[]|number[][]} [attrs.padding] - int, or tuple of 2 ints, or tuple of 2 tuples of 2 ints
   * @param {string} [attrs.data_format] - either 'channels_last' or 'channels_first'
   */
  constructor(attrs = {}) {
    super(attrs)
    this.layerClass = 'ZeroPadding2D'

    const { padding = [[1, 1], [1, 1]], data_format = 'channels_last' } = attrs

    if (Array.isArray(padding)) {
      if (Array.isArray(padding[0])) {
        // [[int, int], [int, int]]
        this.padding = padding
      } else {
        // [int, int]
        this.padding = [[padding[0], padding[0]], [padding[1], padding[1]]]
      }
    } else {
      // int
      this.padding = [[padding, padding], [padding, padding]]
    }

    this.dataFormat = data_format

    // GPU setup
    if (this.gpu) {
      this.mapInputProgram = webgl2.compileProgram(require('../../mapInput.glsl'))
    }
  }

  /**
   * Layer computational logic
   *
   * @param {Tensor} x
   * @returns {Tensor}
   */
  call(x) {
    if (this.gpu) {
      this._callGPU(x)
    } else {
      this._callCPU(x)
    }
    return this.output
  }

  /**
   * CPU call
   *
   * @param {Tensor} x
   */
  _callCPU(x) {
    // convert to channels_last ordering if necessary
    if (this.dataFormat === 'channels_first') {
      x.tensor = x.tensor.transpose(1, 2, 0)
    }

    this.inputShape = x.tensor.shape
    this.outputShape = [
      this.inputShape[0] + this.padding[0][0] + this.padding[0][1],
      this.inputShape[1] + this.padding[1][0] + this.padding[1][1],
      this.inputShape[2]
    ]
    this.output = new Tensor([], this.outputShape)
    ops.assign(
      this.output.tensor
        .hi(this.inputShape[0] + this.padding[0][0], this.inputShape[1] + this.padding[1][0], this.inputShape[2])
        .lo(this.padding[0][0], this.padding[1][0], 0),
      x.tensor
    )

    // convert back to channels_first ordering if necessary
    if (this.dataFormat === 'channels_first') {
      x.tensor = x.tensor.transpose(2, 0, 1)
      this.output.tensor = this.output.tensor.transpose(2, 0, 1)
    }
  }

  /**
   * Creates row/col index mappings to map input texture to output texture
   *
   * @param {Object} indicesForReshaped
   */
  _createIndexMap(indicesForReshaped) {
    if (this.rowIndexMap && this.colIndexMap) {
      return
    }

    const indicesRow = new Tensor(indicesForReshaped.row.data, indicesForReshaped.row.shape, { type: Int32Array })
    const indicesCol = new Tensor(indicesForReshaped.col.data, indicesForReshaped.col.shape, { type: Int32Array })

    this.rowIndexMap = new Tensor([], this.outputShape, { type: Int32Array })
    this.colIndexMap = new Tensor([], this.outputShape, { type: Int32Array })

    const sliceStart =
      this.dataFormat === 'channels_first'
        ? [0, this.padding[0][0], this.padding[1][0]]
        : [this.padding[0][0], this.padding[1][0], 0]
    const sliceEnd =
      this.dataFormat === 'channels_first'
        ? [this.inputShape[0], this.inputShape[1] + this.padding[0][0], this.inputShape[2] + this.padding[1][0]]
        : [this.inputShape[0] + this.padding[0][0], this.inputShape[1] + this.padding[1][0], this.inputShape[2]]

    ops.assigns(this.rowIndexMap.tensor, -1)
    ops.assigns(this.colIndexMap.tensor, -1)
    ops.assign(this.rowIndexMap.tensor.hi(...sliceEnd).lo(...sliceStart), indicesRow.tensor)
    ops.assign(this.colIndexMap.tensor.hi(...sliceEnd).lo(...sliceStart), indicesCol.tensor)

    this.rowIndexMap.reshapeTo2DSquare()
    this.colIndexMap.reshapeTo2DSquare()
    this.rowIndexMap.createGLTexture('2d', 'int')
    this.colIndexMap.createGLTexture('2d', 'int')
  }

  /**
 * GPU call
 *
 * @param {Tensor} x
 */
  _callGPU(x) {
    if (!x.glTexture) {
      x.reshapeTo2DSquare()
      x.createGLTexture()
    }
    this.inputShape = x.originalShape
    this.outputShape =
      this.dataFormat === 'channels_first'
        ? [
            this.inputShape[0],
            this.inputShape[1] + this.padding[0][0] + this.padding[0][1],
            this.inputShape[2] + this.padding[1][0] + this.padding[1][1]
          ]
        : [
            this.inputShape[0] + this.padding[0][0] + this.padding[0][1],
            this.inputShape[1] + this.padding[1][0] + this.padding[1][1],
            this.inputShape[2]
          ]

    this._createIndexMap(x.indicesForReshaped)

    if (!this.output) {
      this.output = new Tensor([], this.outputShape)
      this.output.reshapeTo2DSquare()
      this.output.createGLTexture()
    }

    webgl2.runProgram({
      program: this.mapInputProgram,
      output: this.output,
      inputs: [
        { input: x, name: 'x' },
        { input: this.rowIndexMap, name: 'rowIndexMap' },
        { input: this.colIndexMap, name: 'colIndexMap' }
      ]
    })

    // GPU -> CPU data transfer
    if (this.outbound.length === 0) {
      this.output.transferFromGLTexture()
      this.output.reshapeFrom2DSquare()
    }
  }
}
